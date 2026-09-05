/**
 * Génération du CSV d'import TCGplayer. Voir docs/04-channels.md partie B.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ LA COLONNE DE QUANTITÉ EST UN DELTA, PAS UNE VALEUR ABSOLUE.            │
 * │ Un entier positif AJOUTE à la quantité existante chez TCGplayer.        │
 * │ Envoyer la quantité absolue DOUBLE l'inventaire à chaque import.        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * C'est la raison d'être de `inventory.tcg_qty_pushed` : il mémorise ce qui a
 * déjà été poussé, et le delta est la différence. Il n'est mis à jour QU'APRÈS
 * confirmation d'un import réussi — jamais à la génération. Si l'import échoue,
 * le delta suivant reste correct.
 */

/** Minimum de vente sur les listings Direct. À revalider dans le Seller Portal. */
export const TCG_DIRECT_MIN_CENTS = 40;

export interface InventoryLine {
  sku: string;
  /** ID TCGplayer : unique par produit + set + condition + printing. */
  tcg_sku_id: string | null;
  qty_on_hand: number;
  qty_reserved_tcg: number;
  /** Ce qui a déjà été confirmé comme poussé chez TCGplayer. */
  tcg_qty_pushed: number;
  /** Prix cible pour ce canal, en cents. Null = pas encore prixé. */
  priceCents: number | null;
  card_name: string;
  set_name: string;
  condition: string;
}

export interface CsvRow {
  sku: string;
  tcgSkuId: string;
  /** LE DELTA. Peut être négatif. Jamais la quantité absolue. */
  addToQuantity: number;
  priceCents: number;
  name: string;
}

export type SkipReason =
  | 'sans_tcg_sku_id'
  | 'sans_prix'
  | 'sous_minimum_direct'
  | 'delta_nul';

export interface BuildResult {
  rows: CsvRow[];
  skipped: { sku: string; reason: SkipReason; detail?: string }[];
}

/**
 * Quantité qu'on VEUT voir chez TCGplayer.
 *
 * Le stock moins ce qui est réservé pour l'autre canal. Voir partie C pour
 * l'allocation.
 */
export function targetQuantity(line: InventoryLine): number {
  return Math.max(0, line.qty_on_hand - line.qty_reserved_tcg);
}

/**
 * Le delta à envoyer. C'est LA fonction à ne pas se tromper.
 *
 *   FAUX : addToQuantity = qty_on_hand - qty_reserved_tcg
 *   JUSTE: addToQuantity = cible - déjà_poussé
 */
export function quantityDelta(line: InventoryLine): number {
  return targetQuantity(line) - line.tcg_qty_pushed;
}

export function buildRows(lines: readonly InventoryLine[]): BuildResult {
  const rows: CsvRow[] = [];
  const skipped: BuildResult['skipped'] = [];

  for (const line of lines) {
    // Sans ID TCGplayer, aucun push n'est possible : ces IDs ne s'obtiennent
    // qu'en exportant leur catalogue (docs/04 §B.3).
    if (line.tcg_sku_id === null || line.tcg_sku_id === '') {
      skipped.push({ sku: line.sku, reason: 'sans_tcg_sku_id' });
      continue;
    }

    if (line.priceCents === null) {
      // Le système ne devine jamais un prix qu'il n'a pas mesuré.
      skipped.push({ sku: line.sku, reason: 'sans_prix' });
      continue;
    }

    if (line.priceCents < TCG_DIRECT_MIN_CENTS) {
      skipped.push({
        sku: line.sku,
        reason: 'sous_minimum_direct',
        detail: `${line.priceCents} < ${TCG_DIRECT_MIN_CENTS} cents`,
      });
      continue;
    }

    const delta = quantityDelta(line);
    // Un delta nul est une ligne inutile : elle alourdit le fichier et n'a
    // aucun effet. Pire, elle rend le fichier illisible pour un humain qui
    // cherche ce qui a changé.
    if (delta === 0) {
      skipped.push({ sku: line.sku, reason: 'delta_nul' });
      continue;
    }

    rows.push({
      sku: line.sku,
      tcgSkuId: line.tcg_sku_id,
      addToQuantity: delta,
      priceCents: line.priceCents,
      name: `${line.card_name} — ${line.set_name} — ${line.condition}`,
    });
  }

  return { rows, skipped };
}

/** Échappement CSV minimal mais correct : guillemets doublés, champ entre guillemets. */
function cell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Sérialise en CSV.
 *
 * Les en-têtes doivent correspondre EXACTEMENT à ce qu'attend le Seller Portal.
 * Ceux-ci sont dérivés du format documenté ; **à confronter à un vrai
 * `Export Filtered CSV`** avant le premier import réel — un en-tête qui ne
 * correspond pas fait rejeter le fichier entier, ou pire, silencieusement
 * ignorer une colonne.
 */
export const CSV_HEADERS = [
  'TCGplayer Id',
  'Product Line',
  'Set Name',
  'Product Name',
  'Condition',
  'Add to Quantity',
  'TCG Marketplace Price',
] as const;

export function toCsv(rows: readonly CsvRow[]): string {
  const lines = [CSV_HEADERS.join(',')];

  for (const r of rows) {
    lines.push(
      [
        cell(r.tcgSkuId),
        cell('Pokemon'),
        cell(''),
        cell(r.name),
        cell(''),
        // Le delta, signe compris.
        cell(r.addToQuantity),
        // Prix en dollars avec deux décimales : le portail refuse les cents.
        cell((r.priceCents / 100).toFixed(2)),
      ].join(','),
    );
  }

  // CRLF : le Seller Portal est un outil Windows et certains parseurs y tiennent.
  return `${lines.join('\r\n')}\r\n`;
}
