/**
 * Frais par canal.
 *
 * ⚠ CES TAUX SONT DES PLACEHOLDERS NON VÉRIFIÉS.
 *
 * Les taux eBay varient par catégorie et par niveau de vendeur, et un Store les
 * réduit. Ils doivent être relevés dans le Seller Hub avant l'étape 7 — c'est une
 * des vérifications en attente. Tant que `verified` vaut false, toute UI qui
 * affiche un net doit l'étiqueter comme une estimation.
 *
 * Ne « corrige » pas ces chiffres au jugé : un taux plausible mais faux est pire
 * qu'un taux visiblement provisoire, parce qu'il cesse d'être questionné.
 */
export const FEES = {
  verified: false,

  ebay: {
    /** Final Value Fee, fraction du prix total. */
    fvfRate: 0.1335,
    /** Frais fixe par commande, en dollars. */
    perOrderFee: 0.4,
  },

  tcgplayer: {
    /** Commission, fraction du prix. */
    commission: 0.1075,
  },
} as const;
