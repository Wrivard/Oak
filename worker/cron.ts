import { log } from '../lib/log.js';
import { enqueue } from './queue/queue.js';
import { pruneTraces } from './queue/trace.js';
import { pruneThumbs } from '../lib/images/thumb-cache.js';

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

  // Export TCGplayer : un fichier par jour, clé d'idempotence sur la date. Le
  // doc décrit un batch quotidien, pas un flux temps réel.
  const day = new Date().toISOString().slice(0, 10);
  const exportId = await enqueue(
    'tcg_export',
    {},
    { idempotencyKey: `tcg_export:${day}` },
  );
  if (exportId !== null) log.info('export TCGplayer enfilé', { job_id: exportId });

  // Les traces d'appels sont de la télémétrie, pas de l'historique : leur
  // intérêt décroît avec l'âge et la table gonflerait sans fin.
  await pruneTraces();

  // Même raisonnement sur le disque : une vignette par scan, ~60 ko, et rien ne
  // les effaçait. À 25-50 000 cartes par mois ça fait 1,5 à 3 Go par mois,
  // indéfiniment. Elles ne servent qu'à la review et à l'audit, et se
  // régénèrent à la demande.
  await pruneThumbs();
}

export function startCron(): NodeJS.Timeout {
  void tick().catch((err: unknown) => log.error('cron initial en échec', { err }));
  return setInterval(() => {
    void tick().catch((err: unknown) => log.error('cron en échec', { err }));
  }, HOUR_MS);
}
