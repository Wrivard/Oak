import { describe, expect, it } from 'vitest';
import {
  buildRows,
  quantityDelta,
  targetQuantity,
  toCsv,
  TCG_DIRECT_MIN_CENTS,
  type InventoryLine,
} from '../lib/channels/tcgplayer-csv.js';

/**
 * Le piège qui corrompt l'inventaire. Voir docs/04-channels.md §B.2.
 *
 * La colonne de quantité du CSV TCGplayer est un DELTA. Envoyer la quantité
 * absolue double l'inventaire à chaque import — silencieusement, et on ne s'en
 * rend compte qu'en recevant des commandes qu'on ne peut pas honorer.
 *
 * Ces tests existent d'abord pour ça.
 */
const line = (over: Partial<InventoryLine> = {}): InventoryLine => ({
  sku: 'base1-4-normal-NM-en',
  tcg_sku_id: '123456',
  qty_on_hand: 5,
  qty_reserved_tcg: 0,
  tcg_qty_pushed: 0,
  priceCents: 1000,
  card_name: 'Charizard',
  set_name: 'Base',
  condition: 'NM',
  ...over,
});

describe('quantité — le delta, jamais l’absolu', () => {
  it('premier push : le delta EST la quantité cible', () => {
    expect(quantityDelta(line({ qty_on_hand: 5, tcg_qty_pushed: 0 }))).toBe(5);
  });

  it('deuxième push sans changement : delta ZÉRO, pas 5', () => {
    // C'est LE test. Avec la formule fausse (qty_on_hand - qty_reserved_tcg) on
    // renverrait 5 et TCGplayer passerait de 5 à 10 exemplaires en stock.
    expect(quantityDelta(line({ qty_on_hand: 5, tcg_qty_pushed: 5 }))).toBe(0);
  });

  it('après une vente ailleurs : delta NÉGATIF', () => {
    expect(quantityDelta(line({ qty_on_hand: 3, tcg_qty_pushed: 5 }))).toBe(-2);
  });

  it('la réservation de l’autre canal réduit la cible', () => {
    expect(targetQuantity(line({ qty_on_hand: 7, qty_reserved_tcg: 2 }))).toBe(5);
    expect(
      quantityDelta(line({ qty_on_hand: 7, qty_reserved_tcg: 2, tcg_qty_pushed: 3 })),
    ).toBe(2);
  });

  it('la cible ne descend jamais sous zéro', () => {
    // La réservation peut dépasser le stock le temps qu'un clamp s'applique.
    // Une cible négative deviendrait un delta absurde.
    expect(targetQuantity(line({ qty_on_hand: 1, qty_reserved_tcg: 4 }))).toBe(0);
  });

  it('retirer tout le stock donne exactement l’opposé de ce qui est poussé', () => {
    expect(quantityDelta(line({ qty_on_hand: 0, tcg_qty_pushed: 4 }))).toBe(-4);
  });
});

describe('buildRows — ce qui est écarté, et pourquoi', () => {
  it('écarte une ligne sans tcg_sku_id', () => {
    // Sans ID TCGplayer aucun push n'est possible : ils ne s'obtiennent qu'en
    // exportant leur catalogue.
    const r = buildRows([line({ tcg_sku_id: null })]);
    expect(r.rows).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe('sans_tcg_sku_id');
  });

  it('écarte une ligne sans prix plutôt que d’en inventer un', () => {
    const r = buildRows([line({ priceCents: null })]);
    expect(r.skipped[0]?.reason).toBe('sans_prix');
  });

  it('écarte une ligne sous le minimum Direct de 0,40 $', () => {
    const r = buildRows([line({ priceCents: TCG_DIRECT_MIN_CENTS - 1 })]);
    expect(r.skipped[0]?.reason).toBe('sous_minimum_direct');
  });

  it('accepte une ligne pile au minimum', () => {
    const r = buildRows([line({ priceCents: TCG_DIRECT_MIN_CENTS })]);
    expect(r.rows).toHaveLength(1);
  });

  it('écarte un delta nul : une ligne sans effet alourdit le fichier', () => {
    const r = buildRows([line({ qty_on_hand: 5, tcg_qty_pushed: 5 })]);
    expect(r.rows).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe('delta_nul');
  });

  it('garde les deltas négatifs : retirer du stock est une opération légitime', () => {
    const r = buildRows([line({ qty_on_hand: 1, tcg_qty_pushed: 4 })]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.addToQuantity).toBe(-3);
  });
});

describe('toCsv', () => {
  it('écrit l’en-tête puis une ligne par entrée', () => {
    const { rows } = buildRows([line()]);
    const csv = toCsv(rows);
    const lines = csv.trimEnd().split('\r\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Add to Quantity');
    expect(lines[1]).toContain('123456');
    expect(lines[1]).toContain('5');
    expect(lines[1]).toContain('10.00');
  });

  it('écrit le prix en dollars, pas en cents', () => {
    // Un prix en cents envoyé tel quel listerait la carte à 1000 $.
    const { rows } = buildRows([line({ priceCents: 349 })]);
    expect(toCsv(rows)).toContain('3.49');
  });

  it('conserve le signe des deltas négatifs', () => {
    const { rows } = buildRows([line({ qty_on_hand: 0, tcg_qty_pushed: 3 })]);
    expect(toCsv(rows)).toContain('-3');
  });

  it('échappe les virgules et guillemets d’un nom de carte', () => {
    const { rows } = buildRows([
      line({ card_name: 'Pikachu, "Surfing"', set_name: 'Base' }),
    ]);
    const csv = toCsv(rows);
    expect(csv).toContain('"Pikachu, ""Surfing"" — Base — NM"');
    // Le fichier doit rester à deux lignes : un échappement raté en créerait
    // une troisième et décalerait toutes les colonnes.
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2);
  });

  it('produit un fichier vide mais valide quand rien n’est à pousser', () => {
    expect(toCsv([]).trimEnd().split('\r\n')).toHaveLength(1);
  });
});
