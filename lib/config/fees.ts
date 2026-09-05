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

  /**
   * Coût d'expédition assumé par le vendeur, en CENTS.
   *
   * Une enveloppe rigide et un timbre pour une carte de bulk, en envoi simple.
   * Non vérifié lui aussi — il dépend du tarif Postes Canada de l'année et du
   * conditionnement retenu.
   *
   * Il vit ICI et pas dans un écran : la review et la grille de prix affichaient
   * chacune un « net » différent pour le même prix, l'une avec 1 $ de port et
   * l'autre avec zéro. Sur une carte à 1,75 $, ça fait 1,11 $ contre 0,12 $ —
   * deux conclusions opposées sur la seule question qui compte à ce niveau de
   * prix.
   */
  shippingCents: 100,

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
