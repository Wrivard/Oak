import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';

/**
 * Le filtre déterministe du niveau 2, vérifié contre le catalogue réel.
 *
 * Les trois formes que prend un numéro de carte, et c'est exactement là que le
 * niveau 2 casse quand il casse :
 *   1. le cas nominal — "4/102"
 *   2. le secret rare — "207/165", numéro au-delà du dénominateur imprimé
 *   3. la promo       — "SWSH284", aucun dénominateur
 *
 * Prérequis : pnpm seed:catalog.
 */
const FILTER = `select id, name, set_id, set_name, printed_total, total
                  from cards
                 where printed_total = $1 and number = $2 and language = $3
                 order by set_release`;

interface Row {
  id: string;
  name: string;
  set_id: string;
  set_name: string;
  printed_total: number;
  total: number;
}

afterAll(async () => {
  await closePool();
});

describe('catalogue — filtre déterministe du niveau 2', () => {
  it('le catalogue est seedé', async () => {
    const { rows } = await query<{ n: string }>('select count(*)::text as n from cards');
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(15_000);
  });

  it('cas nominal : "4/102" réduit à une poignée de candidats contenant Charizard', async () => {
    const { rows } = await query<Row>(FILTER, [102, '4', 'en']);

    // Le filtre ne RÉSOUT pas, il RÉDUIT. Trois sets d'époques différentes
    // partagent printedTotal=102 : Base (1999), HS—Triumphant (2010) et les
    // promos SVP. C'est mesuré, pas supposé — voir le test de distribution.
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(rows.map((r) => r.id)).toContain('base1-4');

    const charizard = rows.find((r) => r.id === 'base1-4');
    expect(charizard?.name).toBe('Charizard');
    expect(charizard?.set_id).toBe('base1');

    // Les candidats viennent de sets distincts : le rerank CLIP a de quoi les
    // séparer. S'ils venaient du même set, ce serait un tout autre problème.
    expect(new Set(rows.map((r) => r.set_id)).size).toBe(rows.length);
  });

  it('secret rare : "207/165" trouvé, numéro au-delà du dénominateur imprimé', async () => {
    const { rows } = await query<Row>(FILTER, [165, '207', 'en']);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('sv3pt5-207');

    // Le cœur du cas : le numéro dépasse le dénominateur imprimé. Le filtre le
    // trouve quand même parce que printed_total est dénormalisé depuis le set
    // sur chaque carte, secret rares comprises.
    expect(207).toBeGreaterThan(rows[0]?.printed_total ?? 0);
  });

  it('promo : "SWSH284" trouvée sans dénominateur', async () => {
    const { rows } = await query<Row>(
      `select id, name, set_id, set_name, printed_total, total
         from cards where number = $1 and language = $2`,
      ['SWSH284', 'en'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('swshp-SWSH284');
    expect(rows[0]?.set_id).toBe('swshp');

    // Piège du set des promos : total (304) est INFÉRIEUR à printed_total (307).
    // Un fallback qui supposerait total >= printed_total se tromperait ici.
    expect(rows[0]?.total).toBeLessThan(rows[0]?.printed_total ?? 0);
  });

  it('le filtre tient sa promesse de 1-4 candidats sur au moins 98 % du catalogue', async () => {
    // Garde de conception, pas une curiosité. docs/02 §4 promet "typiquement
    // 1-4 candidats" et les seuils de l'étape 5 sont calibrés là-dessus. Si un
    // refresh du catalogue fait déraper ce chiffre, on le voit ici, pas en prod.
    const { rows } = await query<{ pct: string }>(
      `with f as (
         select printed_total, number, count(*) as n
           from cards
          where language = 'en' and printed_total is not null
          group by 1, 2
       )
       select round(100.0 * sum(n) filter (where n <= 4) / sum(n), 1)::text as pct
         from f`,
    );

    expect(Number(rows[0]?.pct ?? 0)).toBeGreaterThanOrEqual(98);
  });
});
