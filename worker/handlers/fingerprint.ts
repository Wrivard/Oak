import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { query, withTransaction } from '../../lib/db.js';
import { dhash, phash } from '../../lib/fingerprint/hash.js';
import { embed, toVectorLiteral } from '../../lib/fingerprint/embed.js';
import { log } from '../../lib/log.js';
import { PermanentError } from '../queue/errors.js';
import { enqueue, type Job } from '../queue/queue.js';

/**
 * Calcule les empreintes d'un scan et le passe au matching.
 *
 * Rejouable : recalculer les hachages d'une même image donne le même résultat,
 * et l'enqueue de `match` porte une clé déterministe. Un rejeu ne produit donc
 * ni doublon ni divergence.
 */
interface ScanRow {
  id: string;
  front_path: string;
  back_path: string | null;
  status: string;
}

export async function handleFingerprint(job: Job): Promise<void> {
  const scanId = job.payload['scan_id'];
  if (typeof scanId !== 'string') {
    throw new PermanentError(`payload sans scan_id exploitable: ${JSON.stringify(job.payload)}`);
  }

  const { rows } = await query<ScanRow>(
    'select id, front_path, back_path, status from scans where id = $1',
    [scanId],
  );
  const scan = rows[0];
  if (!scan) {
    // Le scan n'existe plus : rien à recalculer, et retenter n'y changera rien.
    throw new PermanentError(`scan ${scanId} introuvable`);
  }

  // Déjà traité par un run précédent : sortie silencieuse, pas de retraitement.
  if (scan.status !== 'pending') {
    log.debug('scan déjà empreinté, job ignoré', { scan_id: scanId, status: scan.status });
    return;
  }

  const front = await readImage(scan.front_path, scanId);

  let pFront: string;
  let dFront: string;
  let vector: number[];
  try {
    [pFront, dFront, vector] = await Promise.all([
      phash(front),
      dhash(front),
      embed(front),
    ]);
  } catch (err) {
    // Le fichier est LÀ mais ne se décode pas : tronqué, ou pas une image.
    // Retenter ne le réparera pas, et laisser le job mourir laisserait le scan
    // en `pending` POUR TOUJOURS — donc le lot impossible à clore, puisque la
    // clôture refuse tant qu'une carte est en traitement. Une page illisible
    // devient une ligne écartée, comme dans `pair_upload` : visible dans le
    // lot, comptée dans la réconciliation, hors de l'inventaire.
    await marquerIllisible(scanId, err);
    return;
  }

  // Le dos d'une carte Pokémon est constant. Un pHash de dos qui dévie signale
  // une carte insérée à l'envers ou de travers — deux lignes qui attrapent une
  // classe entière d'erreurs d'alimentation. Voir docs/02 §3.
  let pBack: string | null = null;
  if (scan.back_path !== null) {
    try {
      pBack = await phash(await readImage(scan.back_path, scanId));
    } catch (err) {
      // Un verso illisible ne doit pas bloquer le recto, qui porte l'identité.
      log.warn('verso illisible, empreinte de dos ignorée', { scan_id: scanId, err });
    }
  }

  await withTransaction(async (client) => {
    await client.query(
      `update scans
          set phash_front = $2::bit(64),
              dhash_front = $3::bit(64),
              phash_back  = $4::bit(64),
              embedding   = $5::vector,
              status      = 'fingerprinted'
        where id = $1`,
      [scanId, pFront, dFront, pBack, toVectorLiteral(vector)],
    );

    await enqueue(
      'match',
      { scan_id: scanId },
      { idempotencyKey: `match:${scanId}`, client },
    );
  });

  log.info('scan empreinté', { scan_id: scanId, avec_verso: pBack !== null });
}

/**
 * Une image présente mais indécodable devient une ligne écartée.
 *
 * `rejected` est l'état terminal qui n'entre dans aucun inventaire et n'écrit
 * aucune empreinte, mais qui RESTE visible : la feuille est passée dans le
 * scanner, elle doit laisser une trace.
 */
async function marquerIllisible(scanId: string, err: unknown): Promise<void> {
  await query(
    `update scans
        set status = 'rejected', error = $2, resolved_at = now()
      where id = $1 and status = 'pending'`,
    [scanId, `image illisible : ${String(err).slice(0, 200)}`],
  );
  log.warn('image indécodable, scan écarté', { scan_id: scanId, err });
}

async function readImage(path: string, scanId: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    // Volontairement PAS une PermanentError. Le watcher commit la ligne `scans`
    // puis déplace le fichier : entre les deux, il existe une fenêtre où le
    // chemin final n'est pas encore en place. Une erreur ambiguë laisse deux
    // tentatives avec backoff, ce qui couvre la course ; un fichier réellement
    // supprimé meurt quand même vite.
    throw new Error(
      `image illisible pour le scan ${scanId} (${basename(path)}): ${String(err)}`,
    );
  }
}
