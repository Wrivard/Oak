import { query } from '../../lib/db.js';
import type { CardCondition, CardVariant } from '../../lib/sku.js';

/**
 * Inventaire. Conçu pour 12-15k SKUs : la pagination est SERVEUR, jamais un
 * `select *` qu'on filtre dans le navigateur.
 *
 * À ce volume, rendre 15 000 lignes coûte des secondes de rendu et des dizaines
 * de mégaoctets de DOM. On en rend 50.
 */
export const PAGE_SIZE = 50;

export type SortKey = 'value' | 'qty' | 'name' | 'recent';
export type StockFilter = 'all' | 'in_stock' | 'out' | 'unpriced' | 'unlisted';

export interface InventoryRow {
  sku: string;
  card_id: string;
  name: string;
  set_name: string;
  variant: CardVariant;
  condition: CardCondition;
  qty_on_hand: number;
  qty_reserved_tcg: number;
  valueCents: number | null;
  priceCents: number | null;
  image: string | null;
  listedEbay: boolean;
  tcgDirty: boolean;
  lastPricedAt: string | null;
}

export interface InventoryPage {
  rows: InventoryRow[];
  total: number;
  page: number;
  pages: number;
  totals: {
    skus: number;
    cartes: number;
    valeurCents: number;
    sansPrix: number;
  };
}

export interface InventoryParams {
  page?: number;
  search?: string;
  sort?: SortKey;
  filter?: StockFilter;
}

const ORDER: Record<SortKey, string> = {
  value: 'i.value_estimate desc nulls last, i.sku',
  qty: 'i.qty_on_hand desc, i.sku',
  name: 'c.name, i.sku',
  recent: 'i.created_at desc, i.sku',
};

const WHERE: Record<StockFilter, string> = {
  all: 'true',
  in_stock: 'i.qty_on_hand > 0',
  out: 'i.qty_on_hand = 0',
  // Sans prix ET en stock : une carte à zéro qu'on n'a pas prixée n'est pas un
  // problème, elle n'est pas à vendre.
  unpriced: 'i.qty_on_hand > 0 and i.current_price is null',
  unlisted: 'i.qty_on_hand > 0 and i.ebay_listing_id is null',
};

interface Row {
  sku: string;
  card_id: string;
  name: string;
  set_name: string;
  variant: CardVariant;
  condition: CardCondition;
  qty_on_hand: number;
  qty_reserved_tcg: number;
  value_estimate: string | null;
  current_price: string | null;
  image_small: string | null;
  ebay_listing_id: string | null;
  tcg_dirty: boolean;
  last_priced_at: string | null;
  total: string;
}

const cents = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

export async function loadInventory(params: InventoryParams = {}): Promise<InventoryPage> {
  const page = Math.max(1, params.page ?? 1);
  const sort = params.sort ?? 'value';
  const filter = params.filter ?? 'in_stock';
  const search = (params.search ?? '').trim();

  // Le compte total est calculé DANS la même requête par une fenêtre : deux
  // allers-retours pour afficher une page, c'est un de trop.
  const { rows } = await query<Row>(
    `select i.sku, i.card_id, c.name, c.set_name, i.variant, i.condition,
            i.qty_on_hand, i.qty_reserved_tcg,
            i.value_estimate::text, i.current_price::text, c.image_small,
            i.ebay_listing_id, i.tcg_dirty,
            to_char(i.last_priced_at, 'YYYY-MM-DD') as last_priced_at,
            count(*) over ()::text as total
       from inventory i
       join cards c on c.id = i.card_id
      where ${WHERE[filter]}
        and ($1 = '' or c.name_normalized like '%' || lower(immutable_unaccent($1)) || '%'
             or i.sku like '%' || $1 || '%')
      order by ${ORDER[sort]}
      limit $2 offset $3`,
    [search, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );

  const total = Number(rows[0]?.total ?? 0);

  return {
    rows: rows.map((r) => ({
      sku: r.sku,
      card_id: r.card_id,
      name: r.name,
      set_name: r.set_name,
      variant: r.variant,
      condition: r.condition,
      qty_on_hand: r.qty_on_hand,
      qty_reserved_tcg: r.qty_reserved_tcg,
      valueCents: cents(r.value_estimate),
      priceCents: cents(r.current_price),
      image: r.image_small,
      listedEbay: r.ebay_listing_id !== null,
      tcgDirty: r.tcg_dirty,
      lastPricedAt: r.last_priced_at,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    totals: await loadTotals(),
  };
}

/**
 * Les totaux portent sur TOUT l'inventaire, pas sur la page affichée.
 *
 * Une valeur totale qui ne compterait que les 50 lignes visibles serait pire
 * qu'absente : elle serait crue.
 */
async function loadTotals(): Promise<InventoryPage['totals']> {
  const { rows } = await query<{
    skus: string;
    cartes: string;
    valeur: string | null;
    sans_prix: string;
  }>(
    `select count(*)::text as skus,
            coalesce(sum(qty_on_hand), 0)::text as cartes,
            coalesce(sum(value_estimate * qty_on_hand), 0)::text as valeur,
            count(*) filter (where qty_on_hand > 0 and current_price is null)::text as sans_prix
       from inventory where qty_on_hand > 0`,
  );
  const r = rows[0];
  return {
    skus: Number(r?.skus ?? 0),
    cartes: Number(r?.cartes ?? 0),
    valeurCents: Math.round(Number(r?.valeur ?? 0) * 100),
    sansPrix: Number(r?.sans_prix ?? 0),
  };
}
