import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { loadInventory, PAGE_SIZE } from '../app/inventory/queries.js';

/**
 * Requêtes d'inventaire.
 *
 * Un filtre faux ne plante pas : il MENT sur ce qu'on possède. « Sans prix » qui
 * oublierait des lignes ferait croire que tout est prixé, et on listerait des
 * cartes à zéro. C'est du chemin de l'argent, donc c'est testé.
 */
const PREFIX = 'test-inv';
let cards: string[] = [];

async function wipe(): Promise<void> {
  await query(`delete from inventory where sku like $1`, [`%${PREFIX}%`]);
}

beforeAll(async () => {
  await wipe();

  const { rows } = await query<{ id: string }>(
    `select id from cards where image_small is not null order by id limit 4`,
  );
  cards = rows.map((r) => r.id);

  // Quatre lignes qui couvrent chaque combinaison qui compte.
  await query(
    `insert into inventory (sku, card_id, variant, condition, language,
                            qty_on_hand, current_price, value_estimate, ebay_listing_id)
     values
       ($1, $5, 'normal','NM','en', 3, 10.00, 12.00, 'ebay-1'),
       ($2, $6, 'normal','LP','en', 2, null,  5.00,  null),
       ($3, $7, 'normal','MP','en', 0, 4.00,  4.00,  null),
       ($4, $8, 'normal','HP','en', 1, 2.00,  1.00,  null)`,
    [
      `${PREFIX}-stock-price`,
      `${PREFIX}-stock-noprice`,
      `${PREFIX}-empty`,
      `${PREFIX}-unlisted`,
      ...cards,
    ],
  );
});

afterAll(async () => {
  await wipe();
  await closePool();
});

/** Les lignes de ce test uniquement : la base peut contenir autre chose. */
const mine = (rows: { sku: string }[]) => rows.filter((r) => r.sku.includes(PREFIX));

describe('filtres', () => {
  it('« en stock » exclut les quantités nulles', async () => {
    const { rows } = await loadInventory({ filter: 'in_stock', search: PREFIX });
    const skus = mine(rows).map((r) => r.sku);
    expect(skus).toContain(`${PREFIX}-stock-price`);
    expect(skus).not.toContain(`${PREFIX}-empty`);
  });

  it('« épuisées » ne montre QUE les quantités nulles', async () => {
    const { rows } = await loadInventory({ filter: 'out', search: PREFIX });
    expect(mine(rows).map((r) => r.sku)).toEqual([`${PREFIX}-empty`]);
  });

  it('« sans prix » ignore les épuisées', async () => {
    // Une carte à zéro sans prix n'est pas un problème : elle n'est pas à vendre.
    // La compter gonflerait l'alerte et on finirait par l'ignorer.
    const { rows } = await loadInventory({ filter: 'unpriced', search: PREFIX });
    const skus = mine(rows).map((r) => r.sku);
    expect(skus).toEqual([`${PREFIX}-stock-noprice`]);
  });

  it('« non listées » exclut ce qui est déjà sur eBay', async () => {
    const { rows } = await loadInventory({ filter: 'unlisted', search: PREFIX });
    const skus = mine(rows).map((r) => r.sku);
    expect(skus).not.toContain(`${PREFIX}-stock-price`);
    expect(skus).toContain(`${PREFIX}-unlisted`);
  });

  it('« tout » inclut les épuisées', async () => {
    const { rows } = await loadInventory({ filter: 'all', search: PREFIX });
    expect(mine(rows)).toHaveLength(4);
  });
});

describe('montants', () => {
  it('convertit en cents entiers, jamais en float', async () => {
    const { rows } = await loadInventory({ filter: 'all', search: `${PREFIX}-stock-price` });
    const r = mine(rows)[0];
    expect(r?.priceCents).toBe(1000);
    expect(r?.valueCents).toBe(1200);
    expect(Number.isInteger(r?.priceCents)).toBe(true);
  });

  it('rend null plutôt que zéro quand il n’y a pas de prix', async () => {
    // Zéro serait lu comme «gratuit» et non comme «inconnu».
    const { rows } = await loadInventory({ filter: 'all', search: `${PREFIX}-stock-noprice` });
    expect(mine(rows)[0]?.priceCents).toBeNull();
  });
});

describe('pagination', () => {
  it('borne la page à PAGE_SIZE', async () => {
    const { rows } = await loadInventory({ filter: 'all' });
    expect(rows.length).toBeLessThanOrEqual(PAGE_SIZE);
  });

  it('le total compte TOUTES les lignes, pas celles de la page', async () => {
    const page = await loadInventory({ filter: 'all', search: PREFIX });
    expect(page.total).toBe(mine(page.rows).length);
    expect(page.pages).toBeGreaterThanOrEqual(1);
  });

  it('une page au-delà de la fin rend une liste vide, pas une erreur', async () => {
    const { rows } = await loadInventory({ filter: 'all', search: PREFIX, page: 99 });
    expect(rows).toEqual([]);
  });
});

describe('tri', () => {
  it('par valeur décroissante, nulls en dernier', async () => {
    const { rows } = await loadInventory({ filter: 'all', search: PREFIX, sort: 'value' });
    const values = mine(rows).map((r) => r.valueCents ?? -1);
    const sorted = [...values].sort((a, b) => b - a);
    expect(values).toEqual(sorted);
  });

  it('par quantité décroissante', async () => {
    const { rows } = await loadInventory({ filter: 'all', search: PREFIX, sort: 'qty' });
    const qty = mine(rows).map((r) => r.qty_on_hand);
    expect(qty).toEqual([...qty].sort((a, b) => b - a));
  });
});

describe('recherche', () => {
  it('trouve par SKU', async () => {
    const { rows } = await loadInventory({ filter: 'all', search: `${PREFIX}-empty` });
    expect(mine(rows)).toHaveLength(1);
  });

  it('une recherche vide ne filtre rien', async () => {
    const a = await loadInventory({ filter: 'all', search: '' });
    const b = await loadInventory({ filter: 'all' });
    expect(a.total).toBe(b.total);
  });
});

describe('totaux', () => {
  it('portent sur tout l’inventaire, pas sur la page affichée', async () => {
    // Un total qui ne compterait que les lignes visibles serait pire qu'absent :
    // il serait cru.
    const page = await loadInventory({ filter: 'all', search: PREFIX });
    const { rows } = await query<{ n: string }>(
      'select count(*)::text as n from inventory where qty_on_hand > 0',
    );
    expect(page.totals.skus).toBe(Number(rows[0]?.n));
  });
});
