import { z } from 'zod';
import type { CardCondition } from '../sku.js';

/**
 * Moteur de règles de prix. Voir docs/03-pricing.md §3.
 *
 * La config vit en base (`pricing_rules.config`), éditable sans redeploy. Elle
 * est VALIDÉE à la lecture : une config malformée doit crier, pas produire des
 * prix nuls en silence.
 *
 * Tous les montants sont en CENTS entiers.
 */
export type Channel = 'ebay' | 'tcgplayer';
export type Rounding = 'psych' | 'whole';

const bandSchema = z.object({
  /** Borne haute INCLUSIVE, en dollars. `null` = dernière bande, sans plafond. */
  up_to: z.number().positive().nullable(),
  mode: z.enum(['floor', 'mult']),
  value: z.number().positive(),
  round: z.enum(['psych', 'whole']).optional(),
  flag_review: z.boolean().optional(),
});

export const pricingConfigSchema = z.object({
  hard_floor: z.number().nonnegative(),
  bands: z.array(bandSchema).min(1),
  condition_mult: z.record(z.string(), z.number().positive()),
  graded_bypass: z.boolean(),
  review_threshold: z.number().nonnegative(),
  reprice_delta_pct: z.number().min(0).max(1),
  channel_offsets: z.record(z.string(), z.number().positive()),
});

export type PricingConfig = z.infer<typeof pricingConfigSchema>;
export type Band = z.infer<typeof bandSchema>;

export function parsePricingConfig(raw: unknown): PricingConfig {
  const parsed = pricingConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `pricing_rules.config invalide :\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  // Une dernière bande sans plafond est obligatoire, sinon une carte chère ne
  // tomberait dans aucune bande et `find` renverrait undefined en production.
  const last = parsed.data.bands[parsed.data.bands.length - 1];
  if (last?.up_to !== null) {
    throw new Error('pricing_rules.config : la dernière bande doit avoir up_to = null');
  }
  return parsed.data;
}

/**
 * Arrondi psychologique : la plus petite valeur ≥ p qui finit par ,49 ou ,99.
 *
 * 3,45 → 3,49   26,25 → 26,49   3,50 → 3,99   3,99 → 3,99   4,00 → 4,49
 */
export function roundPsych(cents: number): number {
  const dollars = Math.floor(cents / 100);
  const rest = cents - dollars * 100;
  if (rest <= 49) return dollars * 100 + 49;
  if (rest <= 99) return dollars * 100 + 99;
  return (dollars + 1) * 100 + 49;
}

/** Arrondi au dollar le plus proche. Neutre : ni en faveur ni au détriment. */
export function roundWhole(cents: number): number {
  return Math.round(cents / 100) * 100;
}

function applyRounding(cents: number, mode: Rounding | undefined): number {
  if (mode === 'psych') return roundPsych(cents);
  if (mode === 'whole') return roundWhole(cents);
  return Math.round(cents);
}

export interface Suggestion {
  priceCents: number;
  band: Band;
  /** La bande demande-t-elle une review avant publication ? */
  flagReview: boolean;
  breakdown: Record<string, unknown>;
}

/**
 * Prix suggéré à partir d'une valeur estimée.
 *
 * Ordre exact du doc, et il compte :
 *   1. multiplicateur de condition
 *   2. sélection de bande sur la valeur AJUSTÉE (avant offset de canal)
 *   3. mode de bande : plancher fixe ou multiplicateur
 *   4. offset de canal
 *   5. plancher dur
 *   6. arrondi
 *
 * Sélectionner la bande après l'offset ferait basculer des cartes d'une bande à
 * l'autre selon le canal, ce qui n'est pas ce que la grille décrit.
 */
export function suggestPrice(
  valueCents: number,
  condition: CardCondition,
  cfg: PricingConfig,
  channel: Channel,
): Suggestion {
  if (!Number.isFinite(valueCents)) {
    throw new Error('suggestPrice: valeur non finie');
  }
  // Une valeur négative est une anomalie de données, pas un prix. On la traite
  // comme zéro : le plancher dur s'appliquera, et rien n'est publié sous lui.
  const safeValue = Math.max(0, Math.round(valueCents));

  const condMult = cfg.condition_mult[condition];
  if (condMult === undefined) {
    throw new Error(`suggestPrice: condition ${condition} absente de condition_mult`);
  }

  const adjusted = safeValue * condMult;
  const adjustedDollars = adjusted / 100;

  const band = cfg.bands.find((b) => b.up_to === null || adjustedDollars <= b.up_to);
  if (!band) throw new Error('suggestPrice: aucune bande ne couvre cette valeur');

  const base = band.mode === 'floor' ? band.value * 100 : adjusted * band.value;
  const offset = cfg.channel_offsets[channel] ?? 1.0;
  const withOffset = base * offset;
  const floored = Math.max(withOffset, cfg.hard_floor * 100);
  const priceCents = applyRounding(floored, band.round);

  return {
    priceCents,
    band,
    flagReview:
      band.flag_review === true || priceCents >= cfg.review_threshold * 100,
    breakdown: {
      value_cents: valueCents,
      condition,
      condition_mult: condMult,
      adjusted_cents: Math.round(adjusted),
      band: { up_to: band.up_to, mode: band.mode, value: band.value, round: band.round },
      channel,
      channel_offset: offset,
      hard_floor_cents: Math.round(cfg.hard_floor * 100),
      price_cents: priceCents,
    },
  };
}

/**
 * Un mouvement supérieur à ce seuil en un cycle est une anomalie de DONNÉES, pas
 * le marché. C'est ce garde-fou qui empêche de lister 3 000 cartes à 0,01 $
 * pendant la nuit parce qu'une source a renvoyé des centimes au lieu de dollars.
 */
export const MAX_SWING_PCT = 0.4;

export function isAnomalousSwing(oldCents: number | null, newCents: number): boolean {
  if (oldCents === null || oldCents === 0) return false;
  return Math.abs(newCents - oldCents) / oldCents > MAX_SWING_PCT;
}

/** Le delta justifie-t-il de pousser une révision au canal ? */
export function worthPushing(
  oldCents: number | null,
  newCents: number,
  cfg: PricingConfig,
): boolean {
  if (oldCents === null || oldCents === 0) return true;
  return Math.abs(newCents - oldCents) / oldCents >= cfg.reprice_delta_pct;
}
