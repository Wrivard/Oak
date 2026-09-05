'use server';

import { query } from '../../lib/db.js';
import { log } from '../../lib/log.js';
import { applyResolution } from '../../lib/resolution.js';
import type { CardCondition, CardVariant } from '../../lib/sku.js';

/**
 * Actions de la review. Elles écrivent en base et rien d'autre.
 *
 * Invariant 4 de CLAUDE.md : aucun appel API externe depuis une requête HTTP.
 * Une action qui aurait besoin d'un effet de bord externe enfile un job.
 */
export interface ConfirmInput {
  scanId: string;
  cardId: string;
  variant: CardVariant;
  condition: CardCondition;
  language: string;
  /** Prix final saisi, en cents. Null = pas de prix décidé maintenant. */
  priceCents: number | null;
}

export interface ActionResult {
  ok: boolean;
  sku?: string;
  error?: string;
}

interface ScanRow {
  status: string;
  phash_front: string | null;
  dhash_front: string | null;
  embedding: string | null;
}

/**
 * Confirme une identification faite à la main.
 *
 * C'est le mécanisme qui rend le système gratuit : chaque confirmation écrit
 * dans `known_fingerprints` avec `confirmed_by = 'manual'`, et la prochaine
 * occurrence de cette carte sera attrapée par le niveau 1 sans OCR ni recherche
 * CLIP.
 */
export async function confirmScan(input: ConfirmInput): Promise<ActionResult> {
  const { rows } = await query<ScanRow>(
    `select status, phash_front::text as phash_front,
            dhash_front::text as dhash_front, embedding::text as embedding
       from scans where id = $1`,
    [input.scanId],
  );
  const scan = rows[0];

  if (!scan) return { ok: false, error: 'scan introuvable' };

  // Garde d'idempotence : deux onglets ouverts, ou un double appui sur A, ne
  // doivent pas incrémenter deux fois la quantité.
  if (scan.status === 'resolved') {
    return { ok: false, error: 'ce scan est déjà résolu' };
  }
  if (scan.phash_front === null || scan.dhash_front === null || scan.embedding === null) {
    return { ok: false, error: 'scan sans empreintes, impossible à confirmer' };
  }

  try {
    const sku = await applyResolution({
      scanId: input.scanId,
      identity: {
        card_id: input.cardId,
        variant: input.variant,
        condition: input.condition,
        language: input.language,
      },
      source: 'manual',
      // Une confirmation humaine est la seule source de vérité du système.
      confidence: 1,
      phash: scan.phash_front,
      dhash: scan.dhash_front,
      embedding: scan.embedding,
    });

    if (input.priceCents !== null) {
      await setPrice(sku, input.priceCents);
    }

    log.info('scan confirmé à la main', {
      scan_id: input.scanId,
      sku,
      card_id: input.cardId,
    });
    // Pas de revalidatePath : la file est gérée côté client et se met à jour
    // sans aller-retour. Revalider forcerait un re-render serveur complet à
    // chaque carte — 3 secondes par carte ne le supportent pas.
    return { ok: true, sku };
  } catch (err) {
    log.error('confirmation impossible', { scan_id: input.scanId, err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Prix décidé à la main. Écrit dans `inventory` ET dans `price_history` : on doit
 * pouvoir répondre plus tard à « pourquoi cette carte est à ce prix ».
 */
async function setPrice(sku: string, priceCents: number): Promise<void> {
  const price = (priceCents / 100).toFixed(2);
  await query(
    `update inventory set current_price = $2, last_priced_at = now(), updated_at = now()
      where sku = $1`,
    [sku, price],
  );
  await query(
    `insert into price_history (sku, price, reason) values ($1, $2, 'manual')`,
    [sku, price],
  );
}

/**
 * Écarte un scan qui n'est pas une carte.
 *
 * Un intercalaire, une page blanche, une photo ratée : ça arrive dans tout lot
 * réel, et sans ce chemin ces pages resteraient en review pour toujours à polluer
 * le compteur.
 *
 * `rejected` est un état terminal DISTINCT de `resolved` : la ligne reste, avec sa
 * trace, mais elle n'entre dans aucun inventaire et n'écrit aucune empreinte. On
 * ne supprime rien — une page écartée par erreur doit pouvoir être retrouvée.
 */
export async function rejectScan(scanId: string, reason = 'pas une carte'): Promise<ActionResult> {
  const { rows } = await query<{ status: string }>(
    'select status from scans where id = $1',
    [scanId],
  );
  const status = rows[0]?.status;
  if (!status) return { ok: false, error: 'scan introuvable' };
  if (status === 'resolved') {
    // Rejeter après résolution laisserait une quantité en inventaire sans scan
    // pour la justifier.
    return { ok: false, error: 'ce scan est déjà résolu — corrige l’inventaire à la main' };
  }

  await query(
    `update scans set status = 'rejected', error = $2, resolved_at = now()
      where id = $1`,
    [scanId, reason],
  );
  log.info('scan écarté', { scan_id: scanId, raison: reason });
  return { ok: true };
}

/**
 * Charge la suite de la file.
 *
 * La page n'en rend que 200 d'un coup — au-delà le DOM et le temps de rendu
 * deviennent perceptibles. Mais il peut y en avoir des milliers en attente, et
 * annoncer « file vide » après 200 cartes serait un mensonge.
 *
 * `exclude` évite de recharger celles déjà à l'écran, y compris celles dont la
 * confirmation est encore en vol.
 */
export async function loadMore(exclude: readonly string[], limit = 200) {
  const { loadReviewQueue } = await import('./queries.js');
  const next = await loadReviewQueue(limit + exclude.length);
  const seen = new Set(exclude);
  return next.filter((s) => !seen.has(s.id)).slice(0, limit);
}

/**
 * Recherche plein texte dans le catalogue, pour les cas où aucun candidat ne
 * convient. Ouverte seulement à la demande (touche S) — le chemin nominal reste
 * le choix d'un candidat au clavier.
 */
export interface SearchHit {
  card_id: string;
  name: string;
  set_name: string;
  number: string;
  printed_total: number | null;
}

export async function searchCatalog(term: string): Promise<SearchHit[]> {
  const clean = term.trim();
  if (clean.length < 2) return [];

  const { rows } = await query<SearchHit>(
    `select id as card_id, name, set_name, number, printed_total
       from cards
      where name_normalized like '%' || lower(immutable_unaccent($1)) || '%'
      order by similarity(name_normalized, lower(immutable_unaccent($1))) desc,
               set_release desc nulls last
      limit 20`,
    [clean],
  );
  return rows;
}
