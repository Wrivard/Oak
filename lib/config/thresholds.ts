/**
 * LE fichier des seuils. Invariant du skill card-matching-thresholds §2 :
 * aucune valeur numérique de seuil ailleurs dans le codebase.
 *
 * Ces valeurs viennent de la spec et des mesures de l'étape 3. Elles ne sont PAS
 * calibrées sur de vrais scans : l'expérience 1bis de PROMPTS.md n'a pas encore
 * tourné. Tout changement passe par tests/golden.test.ts.
 */
export const THRESHOLDS = {
  /**
   * Niveau 1 — scan vs tes scans passés. Même scanner, même éclairage : on est
   * en régime quasi-duplicata, les hachages sont impitoyables et c'est voulu.
   *
   * Marge mesurée sur 741 paires de cartes distinctes : la somme des deux
   * distances n'est jamais descendue sous 29. Le budget ici est 8 + 10 = 18,
   * soit onze points de marge. Voir docs/02 §3.
   */
  ownHistory: { phashMax: 8, dhashMax: 10 },

  /**
   * Niveau 2 — scan vs image catalogue. Render officiel contre scan physique :
   * transformation majeure, d'où CLIP et non les hachages.
   *
   * `minMargin` est la condition qui attrape les artworks réimprimés et les
   * promos. Un candidat à 0,14 avec un deuxième à 0,145 est une ambiguïté, pas
   * un match. Ne jamais la retirer pour gonfler le taux d'auto-résolution.
   */
  catalog: { cosineMax: 0.15, minMargin: 0.06 },

  /** Au-dessus de cette valeur, une carte ne s'auto-publie jamais sans un oeil. */
  autoAccept: { maxValue: 20.0 },

  /**
   * Au-dessus, review manuelle obligatoire quelle que soit la confiance.
   *
   * REPLI SEULEMENT. La valeur qui fait foi est
   * `pricing_rules.config.review_threshold`, éditable sur `/pricing` sans
   * redéploiement — le même nombre existait ici et là-bas, et éditer le champ
   * ne changeait que le drapeau de publication pendant que la review continuait
   * de colorer selon celui-ci. On ne garde celui-ci que pour afficher la review
   * quand la configuration de prix est illisible.
   */
  hardReview: { minValue: 75.0 },

  /**
   * Géométrie du crop OCR du bloc numéro.
   *
   * Crop LARGE volontairement : la position du bloc varie selon l'ère, et un
   * crop serré en bas à gauche marche sur du moderne et rate le vintage. C'est
   * l'expérience 1bis qui décidera s'il faut affiner par ère — ces valeurs sont
   * un point de départ, pas un réglage.
   */
  ocr: {
    /**
     * Bandes essayées dans l'ordre, jusqu'à ce qu'une lecture corresponde à une
     * vraie carte du catalogue. Fractions de la largeur/hauteur de l'image.
     *
     * Mesuré sur les images officielles : le bloc numéro est en bas à GAUCHE sur
     * le moderne (SV, SM) et en bas à DROITE sur le vintage (Base). Un crop
     * unique ne peut pas couvrir les deux — d'où la liste.
     *
     * On n'essaie PAS de deviner l'ère avant le crop : on ne la connaît qu'une
     * fois la carte identifiée. C'est le catalogue qui arbitre, pas une
     * heuristique de mise en page.
     */
    bands: [
      { top: 0.88, left: 0.0, width: 0.5 },  // moderne, bas-gauche
      { top: 0.88, left: 0.5, width: 0.5 },  // vintage, bas-droite
      { top: 0.88, left: 0.0, width: 1.0 },  // pleine largeur, filet
      { top: 0.80, left: 0.0, width: 1.0 },  // bande haute, promos et e-Card
    ],
    /** Agrandissement avant OCR : tesseract aime les grands glyphes. */
    upscale: 3,
    /** Sous cette confiance tesseract, la lecture est ignorée. */
    minConfidence: 45,
  },
} as const;
