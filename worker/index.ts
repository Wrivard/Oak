import { closePool } from '../lib/db.js';
import { loadEnv } from '../lib/env.js';
import { log } from '../lib/log.js';
import { handleFingerprint } from './handlers/fingerprint.js';
import { handleMatch } from './handlers/match.js';
import { startWatcher } from './ingest/watcher.js';
import { Worker } from './queue/loop.js';

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
  match: { handler: handleMatch, concurrency: 2 },
});

const watcher = startWatcher({ inbox: INBOX, processed: PROCESSED, rejected: REJECTED });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('signal reçu, arrêt propre', { signal });

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
