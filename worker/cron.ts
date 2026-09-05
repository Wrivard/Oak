import { log } from '../lib/log.js';
import { enqueue } from './queue/queue.js';
import { pruneTraces } from './queue/trace.js';

/**
 * Planificateur interne. Voir docs/03-pricing.md §5.
 *
 * Pas de dépendance externe pour ça : un `setInterval` dans le worker suffit, et
 * la clé d'idempotence horaire garantit qu'un redémarrage ou deux workers ne
 * produisent pas deux batchs pour la même heure.
 */
const HOUR_MS = 60 * 60 * 1000;

/** `price_refresh:2026-09-04T18` — déterministe, donc rejouable sans doublon. */
function hourKey(now = new Date()): string {
  return `price_refresh:${now.toISOString().slice(0, 13)}`;
}

export async function tick(): Promise<void> {
  const id = await enqueue('price_refresh', { limit: 500 }, { idempotencyKey: hourKey() });
  if (id !== null) log.info('batch de repricing enfilé', { job_id: id });

  // Les traces d'appels sont de la télémétrie, pas de l'historique : leur
  // intérêt décroît avec l'âge et la table gonflerait sans fin.
  await pruneTraces();
}

export function startCron(): NodeJS.Timeout {
  void tick().catch((err: unknown) => log.error('cron initial en échec', { err }));
  return setInterval(() => {
    void tick().catch((err: unknown) => log.error('cron en échec', { err }));
  }, HOUR_MS);
}
