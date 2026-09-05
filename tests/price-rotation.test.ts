import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { flagSwing, selectStaleSkus } from '../worker/handlers/price-refresh.js';

/**
 * La rotation du repricing.
 *
 * `last_priced_at` est le compteur de rotation du batch horaire : tout SKU
 * traité — prixé, inchangé, sans données OU signalé — doit être repoussé de
 * 24 h. C'est un invariant, pas un détail.
 *
 * `flagSwing` ne l'estampillait pas. Un SKU signalé pour mouvement anormal
 * restait donc dans l'ensemble candidat POUR TOUJOURS : re-sélectionné toutes
 * les heures, re-cherché auprès de l'API, re-signalé, un événement par heure, et
 * une place du batch de 500 occupée en permanence. Deux cents cartes signalées
 * — ce qu'un seul hoquet de source produit — auraient saturé 40 % de chaque
 * batch et empêché le reste de l'inventaire d'être jamais reprixé.
 */
const CARD = 'base1-4';
const SKU = `${CARD}-normal-NM-en`;

async function wipe(): Promise<void> {
  await query(`delete from channel_events where sku = $1`, [SKU]);
  await query(`delete from price_history where sku = $1`, [SKU]);
  await query(`delete from inventory where sku = $1`, [SKU]);
}

async function creerSku(lastPricedAt: string | null): Promise<void> {
  await query(
    `insert into inventory (sku, card_id, variant, condition, language,
                            qty_on_hand, current_price, last_priced_at)
     values ($1, $2, 'normal', 'NM', 'en', 3, 10.00, $3::timestamptz)`,
    [SKU, CARD, lastPricedAt],
  );
}

async function estCandidat(): Promise<boolean> {
  // On demande large : le tri met les plus chers d'abord, et d'autres SKUs
  // peuvent exister dans la base pendant les tests.
  const rows = await selectStaleSkus(1000);
  return rows.some((r) => r.sku === SKU);
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await closePool();
});

describe('selectStaleSkus', () => {
  it('prend un SKU jamais prixé', async () => {
    await creerSku(null);
    expect(await estCandidat()).toBe(true);
  });

  it('prend un SKU prixé il y a plus de 24 h', async () => {
    await creerSku(new Date(Date.now() - 30 * 3600_000).toISOString());
    expect(await estCandidat()).toBe(true);
  });

  it('ne reprend pas un SKU prixé il y a une heure', async () => {
    await creerSku(new Date(Date.now() - 3600_000).toISOString());
    expect(await estCandidat()).toBe(false);
  });

  it('ignore un SKU épuisé', async () => {
    // Une carte à zéro n'est pas à vendre : la prixer brûlerait du quota d'API
    // pour rien.
    await creerSku(null);
    await query('update inventory set qty_on_hand = 0 where sku = $1', [SKU]);
    expect(await estCandidat()).toBe(false);
  });
});

describe('flagSwing', () => {
  it('SORT LE SKU DU BATCH — sinon il y reste pour toujours', async () => {
    await creerSku(null);
    expect(await estCandidat()).toBe(true);

    await flagSwing(SKU, 1000, 300_000, { estimate: { method: 'tcg_only' } });

    // Repoussé de 24 h comme n'importe quelle autre issue.
    expect(await estCandidat()).toBe(false);
  });

  it('ne pousse PAS le prix anormal', async () => {
    // Le garde-fou qui empêche de lister 3 000 cartes à 0,01 $ la nuit parce
    // qu'une source a renvoyé des centimes.
    await creerSku(null);
    await flagSwing(SKU, 1000, 1, {});

    const { rows } = await query<{ price: string }>(
      'select current_price::text as price from inventory where sku = $1',
      [SKU],
    );
    expect(rows[0]?.price).toBe('10.00');
  });

  it('laisse une trace et garde le POURQUOI', async () => {
    await creerSku(null);
    await flagSwing(SKU, 1000, 300_000, { estimate: { method: 'tcg_only' } });

    const ev = await query<{ payload: { old_cents: number; new_cents: number } }>(
      `select payload from channel_events where sku = $1 and event = 'price_swing'`,
      [SKU],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]?.payload.new_cents).toBe(300_000);

    // Le détail de l'estimation survit dans l'inventaire : « pourquoi cette
    // carte n'est pas prixée » doit rester répondable sans relire les journaux.
    const inv = await query<{ b: { flagged: string; estimate?: unknown } }>(
      'select price_breakdown as b from inventory where sku = $1',
      [SKU],
    );
    expect(inv.rows[0]?.b.flagged).toBe('price_swing');
    expect(inv.rows[0]?.b.estimate).toEqual({ method: 'tcg_only' });
  });

  it('sera réévalué demain, pas jamais', async () => {
    // Signalé n'est pas exclu : si la source s'est remise, la carte se prixera
    // normalement au prochain cycle.
    await creerSku(null);
    await flagSwing(SKU, 1000, 300_000, {});
    await query(
      `update inventory set last_priced_at = now() - interval '25 hours' where sku = $1`,
      [SKU],
    );
    expect(await estCandidat()).toBe(true);
  });
});
