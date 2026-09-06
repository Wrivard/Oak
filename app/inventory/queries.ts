import { query } from '../../lib/db.js';
import { SENS_PAR_DEFAUT, type SortDir, type SortKey, type StockFilter } from './tri.js';
import type { CardCondition, CardVariant } from '../../lib/sku.js';

/**
 * Inventaire. Conçu pour 12-15k SKUs : la pagination est SERVEUR, jamais un
 * `select *` qu'on filtre dans le navigateur.
 *
 * À ce volume, rendre 15 000 lignes coûte des secondes de rendu et des dizaines
 * de mégaoctets de DOM. On en rend 50.
 */
export const PAGE_SIZE = 50;

export type { SortDir, SortKey, StockFilter } from './tri.js';

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
  /** Pourquoi il n'y a pas de prix, quand il n'y en a pas. */
  priceReason: string | null;
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
  dir?: SortDir;
  filter?: StockFilter;
}

/**
 * Les deux sens de chaque colonne, écrits en toutes lettres.
 *
 * Pas de concaténation d'un `dir` venu de l'URL dans le SQL : c'est la même
 * table qui sert de garde. Et pas de `desc` générique non plus — `nulls last`
 * n'a de sens que dans un sens, et une carte sans valeur estimée doit rester en
 * bas quel que soit le tri, jamais en tête d'une liste qu'on trie justement par
 * valeur.
 *
 * Le second critère est toujours `i.sku` : sans lui, deux lignes de même valeur
 * changent de place d'une page à l'autre et la pagination en oublie ou en
 * répète.
 */
export const ORDER: Record<SortKey, Record<SortDir, string>> = {
  value: {
    desc: 'i.value_estimate desc nulls last, i.sku',
    asc: 'i.value_estimate asc nulls last, i.sku',
  },
  qty: {
    desc: 'i.qty_on_hand desc, i.sku',
    asc: 'i.qty_on_hand asc, i.sku',
  },
  name: {
    asc: 'c.name asc, i.sku',
    desc: 'c.name desc, i.sku',
  },
  recent: {
    desc: 'i.created_at desc, i.sku',
    asc: 'i.created_at asc, i.sku',
  },
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
  price_reason: string | null;
  price_method: string | null;
  total: string;
}

const cents = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

export async function loadInventory(params: InventoryParams = {}): Promise<InventoryPage> {
  const page = Math.max(1, params.page ?? 1);
  const sort = params.sort ?? 'value';
  const dir = params.dir ?? SENS_PAR_DEFAUT[sort];
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
            -- POURQUOI cette carte n'a pas de prix. Le pipeline l'écrit déjà
            -- dans price_breakdown ; il ne restait qu'à l'afficher. « non
            -- prixé » sans raison envoie relire les journaux du worker.
            i.price_breakdown->'details'->>'raison' as price_reason,
            i.price_breakdown->>'method' as price_method,
            count(*) over ()::text as total
       from inventory i
       join cards c on c.id = i.card_id
      where ${WHERE[filter]}
        and ($1 = '' or c.name_normalized like '%' || lower(immutable_unaccent($1)) || '%'
             or i.sku like '%' || $1 || '%')
      order by ${ORDER[sort][dir]}
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
      // La méthode seule ne dit rien d'actionnable ; c'est la raison qui dit
      // quoi corriger. On retombe dessus quand il n'y a pas de raison détaillée.
      priceReason:
        r.current_price === null
          ? (r.price_reason ?? (r.price_method === 'no_data' ? 'aucune donnée de prix' : null))
          : null,
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
