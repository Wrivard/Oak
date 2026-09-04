import { FEES } from '../config/fees.js';

/**
 * Le net après frais. Voir docs/03-pricing.md §4.
 *
 * Affiché en permanence dans l'UI de review : à 1,75 $ avec les frais et une
 * enveloppe, la marge est mince à nulle, et il faut voir le chiffre pendant
 * qu'on décide, pas au payout.
 *
 * Les montants sont manipulés en CENTS entiers. CLAUDE.md interdit le float dans
 * un calcul d'argent cumulatif : 0.1 + 0.2 ne vaut pas 0.3, et une erreur de
 * demi-cent répétée 15 000 fois cesse d'être une erreur d'arrondi.
 */
export type Channel = 'ebay' | 'tcgplayer';

export interface NetBreakdown {
  /** Prix de vente, en cents. */
  priceCents: number;
  /** Commission du canal, en cents. */
  feeCents: number;
  /** Frais fixe par commande, en cents. */
  perOrderCents: number;
  /** Coût d'expédition assumé par le vendeur, en cents. */
  shippingCents: number;
  /** Ce qui reste, en cents. Peut être négatif — c'est le but de l'afficher. */
  netCents: number;
  /** Les taux utilisés ont-ils été vérifiés auprès du canal ? */
  verified: boolean;
}

export function netAfterFees(
  priceCents: number,
  shippingCents: number,
  channel: Channel,
): NetBreakdown {
  if (!Number.isInteger(priceCents) || !Number.isInteger(shippingCents)) {
    throw new Error('netAfterFees: les montants doivent être des cents entiers');
  }

  const rate = channel === 'ebay' ? FEES.ebay.fvfRate : FEES.tcgplayer.commission;
  const perOrderCents = channel === 'ebay' ? Math.round(FEES.ebay.perOrderFee * 100) : 0;

  // Arrondi une seule fois, à la fin du calcul de la commission.
  const feeCents = Math.round(priceCents * rate);
  const netCents = priceCents - feeCents - perOrderCents - shippingCents;

  return {
    priceCents,
    feeCents,
    perOrderCents,
    shippingCents,
    netCents,
    verified: FEES.verified,
  };
}

/** 1234 → "12,34 $". Séparateur décimal francophone, comme le reste de l'UI. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')} $`;
}

/** "12,34" ou "12.34" → 1234. Rend null sur une saisie inexploitable. */
export function parseAmount(input: string): number | null {
  const clean = input.trim().replace(/\s|\$/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}
