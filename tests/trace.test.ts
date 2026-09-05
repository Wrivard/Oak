import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { pruneTraces, trace } from '../worker/queue/trace.js';

/**
 * Traces d'appels externes. Voir docs/05-production.md §1.3.
 *
 * Ce qu'elles doivent garantir : ne jamais faire tomber l'appel qu'elles
 * observent, et ne jamais toucher aux événements MÉTIER quand on les purge.
 */
async function wipe(): Promise<void> {
  await query(`delete from channel_events where channel in ('ebay','pokemontcg')`);
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await closePool();
});

describe('trace', () => {
  it('enregistre durée et contexte sur un succès', async () => {
    const res = await trace('ebay', 'test_ok', async () => 'valeur', () => ({
      ok: true,
      status: 200,
      context: { sku: 'x-normal-NM-en' },
    }));
    expect(res).toBe('valeur');

    const { rows } = await query<{ event: string; payload: Record<string, unknown> }>(
      `select event, payload from channel_events where channel='ebay'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('api_test_ok');
    expect(rows[0]?.payload['ok']).toBe(true);
    expect(rows[0]?.payload['statut']).toBe(200);
    expect(typeof rows[0]?.payload['duree_ms']).toBe('number');
  });

  it('enregistre l’échec ET repropage l’erreur', async () => {
    // Une trace qui avalerait l'erreur transformerait une panne en succès
    // silencieux — exactement l'inverse du but.
    await expect(
      trace('ebay', 'test_ko', () => Promise.reject(new Error('boum'))),
    ).rejects.toThrow('boum');

    const { rows } = await query<{ payload: Record<string, unknown> }>(
      `select payload from channel_events where channel='ebay'`,
    );
    expect(rows[0]?.payload['ok']).toBe(false);
    expect(rows[0]?.payload['erreur']).toBe('boum');
  });

  it('la purge épargne les événements métier', async () => {
    // channel_events porte deux choses : de la télémétrie (api_*) et
    // l'historique métier (ventes, mouvements de quantité, price_swing). Purger
    // l'un ne doit jamais entamer l'autre.
    await query(
      `insert into channel_events (channel, event, payload, created_at)
       values ('ebay','api_vieux','{}', now() - interval '60 days'),
              ('ebay','sold','{}', now() - interval '60 days'),
              ('ebay','price_swing','{}', now() - interval '60 days')`,
    );

    const supprimees = await pruneTraces(30);
    expect(supprimees).toBe(1);

    const { rows } = await query<{ event: string }>(
      `select event from channel_events where channel='ebay' order by event`,
    );
    expect(rows.map((r) => r.event)).toEqual(['price_swing', 'sold']);
  });

  it('la purge respecte la fenêtre', async () => {
    await query(
      `insert into channel_events (channel, event, payload, created_at)
       values ('ebay','api_recent','{}', now() - interval '5 days')`,
    );
    expect(await pruneTraces(30)).toBe(0);
  });
});
