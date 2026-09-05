import { query } from '../../lib/db.js';
import { CONDITIONS, VARIANTS, type CardCondition, type CardVariant } from '../../lib/sku.js';

/**
 * Chargement de la file de review. Lecture seule, côté serveur.
 *
 * La `service_role` ne touche jamais le navigateur : ces requêtes tournent dans
 * un server component, comme le worker (docs/05 §4).
 */
export interface Candidate {
  card_id: string;
  name: string;
  set_name: string;
  distance: number;
  /** Image officielle, pour comparer À L'ŒIL avec le scan. */
  image?: string | null;
  /** Numéro imprimé : le discriminant le plus fiable entre rééditions. */
  number?: string | null;
  printedTotal?: number | null;
}

export interface SoldObservation {
  total_cents: number;
  vendu_le: string | null;
}

export interface PriceSource {
  source: string;
  /** Médiane des totaux pour les sources eBay, market TCGplayer sinon. */
  market: string | null;
  /** MOYENNE des totaux (prix + port) pour les sources eBay. */
  mid: string | null;
  low: string | null;
  high: string | null;
  n_sales: number | null;
  window_days: number | null;
  /** Ventes individuelles avec leurs dates, pour la source ebay_sold. */
  sales: SoldObservation[];
}

export interface ReviewScan {
  id: string;
  seq: number;
  session_name: string;
  variant_conflict: boolean;
  /** Ce que l'OCR a lu, ou null s'il n'a rien lu. Voir migration 007. */
  ocrRead: string | null;
  ocrBand: number | null;
  candidates: Candidate[];
  default_variant: CardVariant;
  default_condition: CardCondition;
  default_language: string;
  /** Estimation de valeur si le SKU pressenti existe déjà en stock. */
  valueCents: number | null;
  prices: PriceSource[];
}

/**
 * Les listes viennent de `lib/sku.ts`, pas d'une copie locale.
 *
 * Elles étaient réécrites ici. Deux listes qui doivent s'accorder et rien qui le
 * garantisse : ajouter un variant à un seul endroit rend une option
 * choisissable à l'écran que `buildSku` refuse — ou l'inverse, un variant qui
 * existe en base mais qu'on ne peut pas sélectionner pour corriger une carte.
 */
export const OPTIONS = { variants: VARIANTS, conditions: CONDITIONS };

interface Row {
  id: string;
  seq: number;
  session_name: string;
  variant_conflict: boolean;
  ocr_read: string | null;
  ocr_band: number | null;
  candidates: Candidate[] | null;
  default_variant: CardVariant;
  default_condition: CardCondition;
  default_language: string;
}

export async function loadReviewQueue(limit = 200): Promise<ReviewScan[]> {
  const { rows } = await query<Row>(
    `select s.id, s.seq, ss.name as session_name, s.variant_conflict,
            s.ocr_read, s.ocr_band,
            s.candidates, ss.default_variant, ss.default_condition,
            ss.default_language
       from scans s join sessions ss on ss.id = s.session_id
      where s.status = 'needs_review'
      order by s.created_at, s.seq
      limit $1`,
    [limit],
  );

  if (rows.length === 0) return [];

  // Prix ET images des cartes candidates, en deux allers-retours pour toute la
  // file. Une requête par carte à l'affichage tuerait la page.
  const cardIds = [...new Set(rows.flatMap((r) => (r.candidates ?? []).map((c) => c.card_id)))];
  const [prices, cards] = await Promise.all([loadPrices(cardIds), loadCards(cardIds)]);

  return rows.map((r) => {
    // Les candidats sont enrichis À LA LECTURE plutôt que stockés avec leur
    // image : une URL figée dans du jsonb devient fausse au premier refresh du
    // catalogue, et on afficherait une image morte sans savoir pourquoi.
    const candidates = (r.candidates ?? []).map((c) => ({
      ...c,
      ...(cards.get(c.card_id) ?? {}),
    }));
    const first = candidates[0];
    return {
      id: r.id,
      seq: r.seq,
      session_name: r.session_name,
      variant_conflict: r.variant_conflict,
      ocrRead: r.ocr_read,
      ocrBand: r.ocr_band,
      candidates,
      default_variant: r.default_variant,
      default_condition: r.default_condition,
      default_language: r.default_language,
      valueCents: first ? (prices.get(first.card_id)?.valueCents ?? null) : null,
      prices: first ? (prices.get(first.card_id)?.sources ?? []) : [],
    };
  });
}

interface CardPrices {
  valueCents: number | null;
  sources: PriceSource[];
}

interface CardInfo {
  image: string | null;
  number: string | null;
  printedTotal: number | null;
}

/** Ce qu'il faut pour reconnaître une carte d'un coup d'œil. */
async function loadCards(cardIds: readonly string[]): Promise<Map<string, CardInfo>> {
  const out = new Map<string, CardInfo>();
  if (cardIds.length === 0) return out;

  const { rows } = await query<{
    id: string;
    image_small: string | null;
    number: string;
    printed_total: number | null;
  }>(
    `select id, image_small, number, printed_total
       from cards where id = any($1::text[])`,
    [cardIds],
  );

  for (const r of rows) {
    out.set(r.id, {
      image: r.image_small,
      number: r.number,
      printedTotal: r.printed_total,
    });
  }
  return out;
}

/**
 * Prix courants, par carte.
 *
 * `price_current` est VIDE tant que l'étape 7 n'est pas faite : cette fonction
 * rend alors des listes vides, et l'UI affiche « aucune donnée ». Elle ne
 * fabrique jamais un chiffre — le système ne devine jamais un prix qu'il n'a pas
 * mesuré (docs/05 §7).
 */
async function loadPrices(cardIds: readonly string[]): Promise<Map<string, CardPrices>> {
  const out = new Map<string, CardPrices>();
  if (cardIds.length === 0) return out;

  const { rows } = await query<
    Omit<PriceSource, 'sales'> & { card_id: string; raw: { observations?: SoldObservation[] } | null }
  >(
    `select i.card_id, p.source, p.market::text, p.mid::text, p.low::text,
            p.high::text, p.n_sales, p.window_days, p.raw
       from price_current p
       join inventory i on i.sku = p.sku
      where i.card_id = any($1::text[])
      order by p.source`,
    [cardIds],
  );

  for (const row of rows) {
    const entry = out.get(row.card_id) ?? { valueCents: null, sources: [] };
    entry.sources.push({
      source: row.source,
      market: row.market,
      mid: row.mid,
      low: row.low,
      high: row.high,
      n_sales: row.n_sales,
      window_days: row.window_days,
      // Les dates ne servent que pour les ventes passées : une annonce active
      // n'a pas de date de vente, par définition.
      sales:
        row.source === 'ebay_sold'
          ? (row.raw?.observations ?? []).slice(0, 8)
          : [],
    });
    // La valeur de référence est le market TCGplayer quand il existe.
    if (row.source === 'tcgplayer' && row.market !== null) {
      entry.valueCents = Math.round(Number(row.market) * 100);
    }
    out.set(row.card_id, entry);
  }
  return out;
}
