/**
 * Agrégation des sources de prix. Voir docs/03-pricing.md §2.
 *
 * Tous les montants sont en CENTS entiers. CLAUDE.md interdit le float dans un
 * calcul d'argent cumulatif.
 */
export type EstimateMethod =
  | 'blended'
  | 'tcg_only'
  | 'cardmarket_fallback'
  | 'no_data';

export interface PriceSources {
  /** Ventes eBay récentes, en cents. Vide ou absent si la source n'a rien. */
  ebaySold?: readonly number[];
  /** TCGplayer market, en cents. Peut être null — c'est fréquent, pas exceptionnel. */
  tcgMarket?: number | null;
  tcgMid?: number | null;
  cmTrend?: number | null;
}

export interface Estimate {
  /** Valeur estimée en cents. `null` signifie « on ne sait pas ». */
  valueCents: number | null;
  method: EstimateMethod;
  nComps: number;
  /**
   * Traçabilité complète : sources, valeurs brutes, poids, méthode. Quand un prix
   * surprend dans six mois, on veut voir pourquoi sans rejouer le pipeline.
   */
  breakdown: Record<string, unknown>;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0
    ? Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2)
    : (s[mid] as number);
}

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

/**
 * Retire les valeurs hors de 1,5 × IQR.
 *
 * C'est une DEUXIÈME couche, pas un remplacement de la médiane : une vente
 * aberrante à 200 $ sur une carte à 3 $ — lot mal titré, erreur d'acheteur —
 * déplace la moyenne et pas la médiane.
 *
 * Sous quatre points, un IQR ne veut rien dire : on renvoie l'entrée telle quelle
 * plutôt que d'inventer une statistique.
 */
export function trimOutliers(values: readonly number[]): number[] {
  if (values.length < 4) return [...values];

  const s = [...values].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return s;

  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return s.filter((v) => v >= lo && v <= hi);
}

interface Weighted {
  readonly source: string;
  readonly cents: number | null;
  readonly weight: number;
}

/**
 * Moyenne pondérée qui ignore les sources absentes et renormalise les poids.
 *
 * Sans renormalisation, une source manquante tirerait le résultat vers zéro en
 * silence — exactement le genre d'erreur qui liste 3 000 cartes à 0,01 $.
 */
function weighted(parts: readonly Weighted[]): { cents: number | null; used: Weighted[] } {
  const used = parts.filter((p): p is Weighted & { cents: number } => p.cents !== null);
  if (used.length === 0) return { cents: null, used: [] };

  const totalWeight = used.reduce((s, p) => s + p.weight, 0);
  if (totalWeight === 0) return { cents: null, used: [] };

  const sum = used.reduce((s, p) => s + p.cents * p.weight, 0);
  return { cents: Math.round(sum / totalWeight), used };
}

export function estimateValue(sources: PriceSources): Estimate {
  const comps = trimOutliers(sources.ebaySold ?? []);
  const compMedian = median(comps);

  if (comps.length >= 3 && compMedian !== null) {
    const { cents, used } = weighted([
      { source: 'ebay_sold_median', cents: compMedian, weight: 0.5 },
      { source: 'tcg_market', cents: sources.tcgMarket ?? null, weight: 0.35 },
      { source: 'tcg_mid_or_cm', cents: sources.tcgMid ?? sources.cmTrend ?? null, weight: 0.15 },
    ]);
    return {
      valueCents: cents,
      method: 'blended',
      nComps: comps.length,
      breakdown: {
        method: 'blended',
        n_comps_raw: sources.ebaySold?.length ?? 0,
        n_comps_trimmed: comps.length,
        parts: used,
      },
    };
  }

  if (sources.tcgMarket != null) {
    const { cents, used } = weighted([
      { source: 'tcg_market', cents: sources.tcgMarket, weight: 0.8 },
      { source: 'tcg_mid', cents: sources.tcgMid ?? sources.tcgMarket, weight: 0.2 },
    ]);
    return {
      valueCents: cents,
      method: 'tcg_only',
      nComps: comps.length,
      breakdown: { method: 'tcg_only', n_comps_trimmed: comps.length, parts: used },
    };
  }

  if (sources.cmTrend != null) {
    return {
      valueCents: sources.cmTrend,
      method: 'cardmarket_fallback',
      nComps: comps.length,
      breakdown: {
        method: 'cardmarket_fallback',
        parts: [{ source: 'cm_trend', cents: sources.cmTrend, weight: 1 }],
      },
    };
  }

  // Un système qui invente un prix quand il ne sait pas est pire qu'un système
  // qui s'arrête. `no_data` ne produit JAMAIS de prix : il envoie en review.
  return {
    valueCents: null,
    method: 'no_data',
    nComps: 0,
    breakdown: { method: 'no_data', raison: 'aucune source exploitable' },
  };
}
