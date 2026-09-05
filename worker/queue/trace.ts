import { query } from '../../lib/db.js';
import { log } from '../../lib/log.js';
import type { Service } from './breaker.js';

/**
 * Traces des appels externes. Voir docs/05-production.md §1.3.
 *
 * Durée, statut, taille de payload — stockés dans `channel_events`.
 *
 * La raison d'être : quand eBay renvoie une erreur cryptique dans six mois, on
 * veut le payload exact qui l'a causée, sans avoir à rejouer le pipeline.
 *
 * Ce que la trace ne contient JAMAIS : le corps complet d'une réponse ni rien
 * qui ressemble à un jeton. `lib/log.ts` masque déjà à l'écriture des logs, mais
 * `channel_events` est une table qu'on relira à froid — on n'y met que des
 * métadonnées.
 */
export interface TraceResult {
  ok: boolean;
  status?: number;
  /** Taille approximative de la réponse, en octets. */
  bytes?: number;
  /** Ce qui identifie l'appel : ids demandés, requête, SKU. Jamais de secret. */
  context?: Record<string, unknown>;
}

export async function trace<T>(
  service: Service,
  operation: string,
  fn: () => Promise<T>,
  describe: (result: T) => TraceResult = () => ({ ok: true }),
): Promise<T> {
  const started = Date.now();

  try {
    const result = await fn();
    const info = describe(result);
    await record(service, operation, {
      ok: info.ok,
      duree_ms: Date.now() - started,
      ...(info.status === undefined ? {} : { statut: info.status }),
      ...(info.bytes === undefined ? {} : { octets: info.bytes }),
      ...(info.context ?? {}),
    });
    return result;
  } catch (err) {
    await record(service, operation, {
      ok: false,
      duree_ms: Date.now() - started,
      erreur: err instanceof Error ? err.message : String(err),
      type_erreur: err instanceof Error ? err.name : 'inconnu',
    });
    throw err;
  }
}

async function record(
  service: Service,
  operation: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `insert into channel_events (channel, event, payload)
       values ($1, $2, $3)`,
      [service, `api_${operation}`, payload],
    );
  } catch (err) {
    // Une trace qui échoue ne doit JAMAIS faire tomber l'appel qu'elle observe.
    // Mais elle ne disparaît pas non plus en silence.
    log.warn('trace non enregistrée', { service, operation, err });
  }
}

/**
 * Purge des traces anciennes.
 *
 * À 500 SKUs par heure, la table gonfle vite et son intérêt décroît avec l'âge :
 * on garde 30 jours, ce qui couvre largement un débogage a posteriori.
 * Les événements métier (`sold`, `price_swing`, mouvements de quantité) ne sont
 * PAS touchés — eux sont l'historique, pas de la télémétrie.
 */
export async function pruneTraces(days = 30): Promise<number> {
  const { rowCount } = await query(
    `delete from channel_events
      where event like 'api\\_%'
        and created_at < now() - ($1::int * interval '1 day')`,
    [days],
  );
  if (rowCount && rowCount > 0) {
    log.info('traces purgées', { supprimees: rowCount, plus_vieilles_que_jours: days });
  }
  return rowCount ?? 0;
}
