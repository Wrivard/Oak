import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../lib/db.js';
import { phash } from '../../lib/fingerprint/hash.js';
import { registerScan, registerUnreadablePage } from '../../lib/ingest/register.js';
import { pairPages, type PairMode, type Page } from '../../lib/ingest/pairing.js';
import { log } from '../../lib/log.js';
import { PermanentError } from '../queue/errors.js';
import type { Job } from '../queue/queue.js';

/**
 * Apparie un lot uploadé, puis crée les scans.
 *
 * Le hachage se fait ICI et pas dans la requête d'upload : sur un lot de
 * plusieurs centaines de photos, calculer une empreinte par image dépasserait
 * largement le temps d'une requête HTTP. L'upload écrit les fichiers, ce job les
 * organise — c'est la même séparation que partout ailleurs.
 */
const IMAGE = /\.(jpe?g|png|webp|tiff?)$/i;

export async function handlePairUpload(job: Job): Promise<void> {
  const sessionId = job.payload['session_id'];
  const dir = job.payload['dir'];
  const mode = (job.payload['mode'] ?? 'duplex') as PairMode;

  if (typeof sessionId !== 'string' || typeof dir !== 'string') {
    throw new PermanentError(`payload incomplet : ${JSON.stringify(job.payload)}`);
  }

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => IMAGE.test(f)).sort();
  } catch (err) {
    throw new PermanentError(`dossier du lot illisible (${dir}) : ${String(err)}`);
  }

  // Les fichiers déjà rattachés à un scan sont ignorés : le job doit pouvoir
  // être rejoué sans dupliquer les cartes.
  const { rows: known } = await query<{ p: string }>(
    `select front_path as p from scans where session_id = $1
     union select back_path from scans where session_id = $1 and back_path is not null`,
    [sessionId],
  );
  const seen = new Set(known.map((r) => r.p));

  const pages: Page[] = [];
  const illisibles: { path: string; raison: string }[] = [];
  let index = 0;
  for (const name of files) {
    index += 1;
    const path = join(dir, name);
    if (seen.has(path)) continue;

    try {
      pages.push({ index, path, phash: await phash(await readFile(path)) });
    } catch (err) {
      // Une image illisible ne doit pas emporter le lot. Elle ne disparaît pas
      // non plus : un `log.error` seul en faisait une carte physique sans
      // ligne d'inventaire, avec pour unique trace une ligne de journal que
      // personne ne lit. Elle est enregistrée plus bas comme page écartée.
      log.error('image du lot illisible, non appariée', { path, err });
      illisibles.push({ path, raison: `image illisible : ${String(err).slice(0, 200)}` });
    }
  }

  if (pages.length === 0 && illisibles.length === 0) {
    log.info('lot déjà apparié, rien à faire', { session_id: sessionId, dir });
    return;
  }

  const { pairs, anomalies, alternanceSaine, coherenceDos } = pairPages(pages, mode);

  const { rows: seqRow } = await query<{ next: string }>(
    'select coalesce(max(seq), 0) + 1 as next from scans where session_id = $1',
    [sessionId],
  );
  let seq = Number(seqRow[0]?.next ?? 1);

  for (const pair of pairs) {
    await registerScan({
      sessionId,
      seq,
      frontPath: pair.front.path,
      backPath: pair.back?.path ?? null,
    });
    seq += 1;
  }

  // Les pages illisibles APRÈS les paires : elles ne participent pas à
  // l'appariement, mais elles laissent chacune une ligne visible dans le lot.
  for (const p of illisibles) {
    await registerUnreadablePage({
      sessionId,
      seq,
      frontPath: p.path,
      reason: p.raison,
    });
    seq += 1;
  }

  // Les anomalies sont tracées, pas avalées : un décalage recto/verso non
  // signalé fait grader la mauvaise carte.
  if (anomalies.length > 0) {
    await query(
      `insert into channel_events (channel, event, payload)
       values ('internal', 'upload_anomalies', $1)`,
      [{ session_id: sessionId, dir, anomalies }],
    );
  }

  const niveau = alternanceSaine ? log.info : log.warn;
  niveau('lot apparié', {
    session_id: sessionId,
    pages: pages.length,
    cartes: pairs.length,
    alternance_saine: alternanceSaine,
    coherence_dos: Math.round(coherenceDos * 100) / 100,
    anomalies: anomalies.length,
    mode,
  });
}
