import { closePool } from '../lib/db.js';
import { loadEnv } from '../lib/env.js';
import { log } from '../lib/log.js';
import { handleFingerprint } from './handlers/fingerprint.js';
import { handleMatch } from './handlers/match.js';
import { handlePriceRefresh } from './handlers/price-refresh.js';
import { handlePairUpload } from './handlers/pair-upload.js';
import { handleTcgExport } from './handlers/tcg-export.js';
import { startWatcher } from './ingest/watcher.js';
import { Worker } from './queue/loop.js';
import { startCron } from './cron.js';

/**
 * Point d'entrée du worker. Un process long, séparé de Next.
 *
 * La concurrence est réglée par type : `fingerprint` est du CPU local et peut
 * tourner large, les types qui parleront à eBay resteront à 1 (étape 9).
 */
const env = loadEnv();

const INBOX = process.env['INBOX_DIR'] ?? './inbox';
const PROCESSED = process.env['PROCESSED_DIR'] ?? './processed';
const REJECTED = process.env['REJECTED_DIR'] ?? './rejected';

const worker = new Worker(env.WORKER_ID, {
  fingerprint: { handler: handleFingerprint, concurrency: 4 },
  // OCR + rerank : du CPU local, mais tesseract est plus lourd que les hachages.
  //
  // L'OCR lui-même reste SÉRIALISÉ quoi qu'on mette ici : `readCardNumbers`
  // partage un seul worker tesseract, qui met les lectures en file. Les deux
  // voies ne parallélisent donc que le reste — recherche vectorielle, requêtes,
  // écritures. Vérifié au passage que la file de tesseract ne croise pas les
  // résultats entre lectures simultanées (tests/ocr-concurrence.test.ts) : deux
  // cartes qui échangeraient leur numéro se résoudraient toutes les deux vers la
  // mauvaise carte, avec une confiance élevée, sans jamais passer par la review.
  match: { handler: handleMatch, concurrency: 2 },
  // Hachage d'un lot entier : du CPU, une seule voie pour ne pas concurrencer
  // le matching qui est déjà le goulot.
  //
  // CETTE VALEUR EST AUSSI UNE GARANTIE DE CORRECTION, pas seulement un réglage
  // de performance : `handlePairUpload` alloue les numéros d'ordre par
  // `max(seq) + 1`, ce qui n'est pas sûr sous concurrence. Deux appariements
  // simultanés sur le même lot écraseraient une page. Ne pas monter ce chiffre
  // sans rendre l'allocation atomique d'abord.
  pair_upload: { handler: handlePairUpload, concurrency: 1 },
  // Source externe avec quota : une seule voie, jamais de parallélisme.
  price_refresh: { handler: handlePriceRefresh, concurrency: 1 },
  // Un seul fichier par jour : jamais deux exports concurrents, quelqu'un
  // finirait par uploader les deux et appliquer le delta en double.
  tcg_export: { handler: handleTcgExport, concurrency: 1 },
});

const watcher = startWatcher({ inbox: INBOX, processed: PROCESSED, rejected: REJECTED });
const cron = startCron();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('signal reçu, arrêt propre', { signal });

  clearInterval(cron);
  await watcher.close();
  await worker.stop();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

worker.run().catch((err: unknown) => {
  log.error('worker interrompu', { err });
  process.exitCode = 1;
});
