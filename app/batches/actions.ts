'use server';

import { join } from 'node:path';
import { query } from '../../lib/db.js';
import { log } from '../../lib/log.js';
import { revalidateQuietly } from '../revalidate.js';

/**
 * Clôture d'un lot. Voir docs/02-ingest-and-matching.md §1 et docs/05 §6.2.
 *
 * « Écart non nul = la session ne se ferme pas. » Ce n'est pas une préférence :
 * une double-alimentation fait exister une carte physique sans ligne
 * d'inventaire. On ne la vend pas, on ne la retrouve jamais, et l'écart de
 * comptage est le SEUL signal.
 *
 * Le contournement est possible mais explicite et tracé — parce qu'il existe des
 * cas légitimes (pages blanches écartées volontairement) et qu'un garde-fou
 * qu'on ne peut jamais lever se contourne autrement, en pire.
 */
export interface CloseResult {
  ok: boolean;
  error?: string;
  ecart?: number;
  enCours?: number;
}

export async function closeBatch(sessionId: string, force = false): Promise<CloseResult> {
  const { rows } = await query<{
    name: string;
    status: string;
    expected: number | null;
    scanned: number;
    en_cours: string;
  }>(
    `select ss.name, ss.status, ss.expected_count as expected, ss.scanned_count as scanned,
            count(s.*) filter (
              where s.status in ('pending','fingerprinted','matched')
            )::text as en_cours
       from sessions ss
       left join scans s on s.session_id = ss.id
      where ss.id = $1
      group by ss.id`,
    [sessionId],
  );

  const b = rows[0];
  if (!b) return { ok: false, error: 'lot introuvable' };
  if (b.status !== 'open') return { ok: false, error: 'lot déjà fermé' };

  const enCours = Number(b.en_cours);
  if (enCours > 0) {
    // Fermer pendant que le worker travaille figerait un comptage faux.
    return {
      ok: false,
      error: `${enCours} carte${enCours > 1 ? 's' : ''} encore en traitement — attends la fin`,
      enCours,
    };
  }

  const ecart = b.expected === null ? 0 : b.scanned - b.expected;
  if (ecart !== 0 && !force) {
    return {
      ok: false,
      ecart,
      error:
        `Écart de comptage : ${b.scanned} scannées pour ${b.expected} attendues. ` +
        `Double-alimentation probable. Repasse physiquement la pile avant de fermer.`,
    };
  }

  await query(
    `update sessions set status = 'closed', closed_at = now() where id = $1`,
    [sessionId],
  );

  if (ecart !== 0) {
    // Un contournement laisse une trace permanente : c'est ce qui permettra de
    // comprendre un écart d'inventaire dans six mois.
    await query(
      `insert into channel_events (channel, event, payload)
       values ('internal', 'session_closed_with_gap', $1)`,
      [{ session_id: sessionId, name: b.name, expected: b.expected, scanned: b.scanned, ecart }],
    );
    log.warn('lot fermé MALGRÉ un écart de comptage', {
      session_id: sessionId,
      name: b.name,
      ecart,
    });
  } else {
    log.info('lot fermé', { session_id: sessionId, name: b.name, cartes: b.scanned });
  }

  revalidateQuietly('/batches');
  return { ok: true, ecart };
}

/**
 * Corrige le compteur attendu.
 *
 * L'upload ne connaît pas de compteur de feuilles : `expected_count` reste nul,
 * et la réconciliation ne peut rien vérifier. Saisir le nombre de cartes
 * réellement mises dans le scanner rend le contrôle possible.
 */
export async function setExpected(
  sessionId: string,
  expected: number | null,
): Promise<CloseResult> {
  // `null` EFFACE le comptage. Champ vidé, le client envoyait `Number('')`,
  // c'est-à-dire ZÉRO : un lot de 50 cartes affichait alors un écart de +50 et
  // refusait de se fermer, sans qu'on puisse revenir en arrière — il n'y avait
  // aucun moyen de dire « je ne sais pas » une fois un chiffre saisi.
  //
  // Zéro reste une valeur légitime et distincte : un lot vide est un comptage
  // vérifiable, et le tableau de santé le traitera comme tel.
  if (expected !== null && (!Number.isInteger(expected) || expected < 0)) {
    return { ok: false, error: 'nombre invalide' };
  }
  await query('update sessions set expected_count = $2 where id = $1', [
    sessionId,
    expected,
  ]);
  revalidateQuietly('/batches');
  return { ok: true };
}

/**
 * Relance l'appariement d'un lot.
 *
 * L'appariement est enfilé par le PUT de fin d'envoi. Si ce PUT échoue — le
 * serveur redémarre, le réseau lâche entre le dernier paquet et la
 * finalisation — les pages sont sur le disque et AUCUN job n'existe. Le lot
 * reste alors à zéro carte pour toujours, sans erreur : les fichiers sont là,
 * l'écran d'envoi le dit même (« ce lot contient déjà N pages »), mais rien ne
 * peut les transformer en cartes. C'est un état dont le système ne savait pas
 * sortir.
 *
 * Rejouer est SANS DANGER : `pair_upload` ignore les fichiers déjà rattachés à
 * un scan. Un lot déjà apparié ne bouge pas, un lot à moitié apparié se termine.
 *
 * La clé d'idempotence porte la minute pour que ce soit possible plusieurs fois,
 * là où celle du PUT est fixe par lot et par mode — c'est justement cette clé
 * fixe qui empêchait de réenfiler quoi que ce soit.
 */
export interface PairResult {
  ok: boolean;
  enfile?: boolean;
  error?: string;
}

export async function repairBatch(
  sessionId: string,
  mode: 'duplex' | 'front_only',
): Promise<PairResult> {
  const { rows } = await query<{ name: string; status: string }>(
    'select name, status from sessions where id = $1',
    [sessionId],
  );
  const b = rows[0];
  if (!b) return { ok: false, error: 'lot introuvable' };
  if (b.status !== 'open') {
    // Un lot fermé a été réconcilié : y ajouter des cartes après coup rendrait
    // ce comptage faux sans que rien ne le signale.
    return { ok: false, error: 'lot fermé — rouvre-le d’abord si c’est voulu' };
  }

  const store = process.env['UPLOAD_DIR'] ?? './uploads';
  const dir = join(store, b.name);
  const minute = new Date().toISOString().slice(0, 16);

  const { rows: job } = await query<{ id: string }>(
    `insert into jobs (type, payload, idempotency_key, priority)
     values ('pair_upload', $1, $2, 50)
     on conflict (idempotency_key) do nothing
     returning id::text`,
    [{ session_id: sessionId, dir, mode }, `pair_upload:manuel:${sessionId}:${mode}:${minute}`],
  );

  log.info('appariement relancé à la main', { session: b.name, mode, enfile: job.length > 0 });
  revalidateQuietly('/batches');
  return { ok: true, enfile: job.length > 0 };
}
