import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';

/**
 * Les trois requêtes de matching du niveau 2, vérifiées contre le catalogue réel.
 *
 * Elles couvrent les trois formes que prend un numéro de carte, et c'est
 * exactement là que le niveau 2 casse quand il casse :
 *   1. le cas nominal        — "4/102"
 *   2. le secret rare        — "207/165", numéro au-delà du dénominateur imprimé
 *   3. la promo              — "SWSH284", aucun dénominateur
 *
 * Prérequis : pnpm seed:catalog.
 */
afterAll(async () => {
  await closePool();
});

describe('catalogue — requêtes de résolution niveau 2', () => {
  it('le catalogue est seedé', async () => {
    const { rows } = await query<{ n: string }>('select count(*)::text as n from cards');
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(15_000);
  });

  it('cas nominal : Charizard Base Set, printed_total=102 et number=4 → 1 seule ligne', async () => {
    const { rows } = await query<{ id: string; name: string }>(
      `select id, name from cards
        where printed_total = $1 and number = $2 and language = $3`,
      [102, '4', 'en'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('base1-4');
    expect(rows[0]?.name).toBe('Charizard');
  });

  it('secret rare : number > printed_total, retrouvé via total', async () => {
    // sv3pt5 (151) : 165 imprimées, 207 avec les secret rares.
    // Le filtre sur printed_total ne trouve rien — c'est le fallback qui compte.
    const onPrinted = await query(
      `select id from cards
        where printed_total = $1 and number = $2 and language = $3`,
      [165, '207', 'en'],
    );
    expect(onPrinted.rows).toHaveLength(0);

    const onTotal = await query<{ id: string; number: string; printed_total: number }>(
      `select id, number, printed_total from cards
        where total = $1 and number = $2 and language = $3`,
      [207, '207', 'en'],
    );
    expect(onTotal.rows).toHaveLength(1);
    expect(onTotal.rows[0]?.id).toBe('sv3pt5-207');
    expect(Number(onTotal.rows[0]?.number)).toBeGreaterThan(
      Number(onTotal.rows[0]?.printed_total),
    );
  });

  it('promo : SWSH284 retrouvée sans dénominateur', async () => {
    const { rows } = await query<{ id: string; name: string; set_id: string }>(
      `select id, name, set_id from cards where number = $1 and language = $2`,
      ['SWSH284', 'en'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('swshp-SWSH284');
    expect(rows[0]?.set_id).toBe('swshp');
  });
});
