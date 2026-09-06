import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { triggerPriceRefresh } from '../app/pricing/actions.js';

/**
 * Déclencher un repricing depuis l'écran.
 *
 * Le cron passe toutes les heures sur 500 SKUs. Après avoir changé une règle,
 * attendre l'heure suivante pour voir l'effet sur de vraies cartes n'est pas
 * tenable — et la seule alternative documentée était d'ouvrir psql pour insérer
 * un job à la main, ce qui n'est pas une interface.
 *
 * ON ENFILE UN JOB. Invariant 4 de CLAUDE.md : aucun appel API externe dans une
 * requête HTTP.
 */
async function wipe(): Promise<void> {
  await query(`delete from jobs where idempotency_key like 'price_refresh:manuel:%'`);
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await closePool();
});

describe('triggerPriceRefresh', () => {
  it('enfile un job, et n’appelle rien', async () => {
    const res = await triggerPriceRefresh(50);
    expect(res.ok).toBe(true);
    expect(res.enfile).toBe(true);

    const { rows } = await query<{ type: string; status: string; payload: { limit: number } }>(
      `select type, status, payload from jobs
        where idempotency_key like 'price_refresh:manuel:%'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('price_refresh');
    expect(rows[0]?.payload.limit).toBe(50);
    // Le STATUT n'est pas vérifié : le lanceur garde un worker en permanence,
    // et ce worker a le droit de réclamer le job entre l'insertion et cette
    // requête. Ce que la fonction promet, c'est qu'un job du bon type et du bon
    // contenu existe — pas qu'il attende encore.
    expect(['queued', 'running', 'done', 'failed', 'dead']).toContain(rows[0]?.status);
  });

  it('TROIS CLICS N’ENFILENT QU’UN BATCH', async () => {
    // L'impatience ne doit pas brûler le quota de l'API : un batch de 500 SKUs
    // fait cinq appels, et trois batchs en feraient quinze pour rien.
    const [a, b, c] = await Promise.all([
      triggerPriceRefresh(50),
      triggerPriceRefresh(50),
      triggerPriceRefresh(50),
    ]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    expect([a.enfile, b.enfile, c.enfile].filter(Boolean)).toHaveLength(1);

    const { rows } = await query(
      `select 1 from jobs where idempotency_key like 'price_refresh:manuel:%'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuse une limite absurde', async () => {
    // Un batch de 100 000 SKUs ne finirait jamais et tiendrait la voie unique
    // du repricing occupée.
    expect((await triggerPriceRefresh(0)).ok).toBe(false);
    expect((await triggerPriceRefresh(-5)).ok).toBe(false);
    expect((await triggerPriceRefresh(100_000)).ok).toBe(false);
    expect((await triggerPriceRefresh(2.5)).ok).toBe(false);

    const { rows } = await query(
      `select 1 from jobs where idempotency_key like 'price_refresh:manuel:%'`,
    );
    expect(rows).toHaveLength(0);
  });
});
