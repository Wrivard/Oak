'use client';

import type { ReactNode } from 'react';

/**
 * Une infobulle qui apparaît TOUT DE SUITE.
 *
 * L'application expliquait déjà beaucoup de choses par l'attribut `title` du
 * navigateur : pourquoi une carte n'a pas de prix, ce que déclenche une alarme,
 * ce que fait un champ. Le problème n'est pas ce qu'elles disent, c'est
 * qu'elles arrivent après une demi-seconde d'immobilité, dans le style du
 * système d'exploitation, au ras du curseur — donc elles ne se lisent jamais.
 * Une explication qu'on ne lit pas n'a pas été écrite.
 *
 * Sans JavaScript de positionnement : `:hover` et `:focus-within` en CSS, texte
 * porté par un attribut. Une bibliothèque de placement flottant pour dix
 * infobulles dans une application locale serait payer un problème qu'on n'a
 * pas — les nôtres sont au milieu de l'écran, jamais collées à un bord.
 *
 * `cote="fin"` aligne l'infobulle sur la DROITE de son ancre, pour les colonnes
 * de fin de tableau où elle sortirait du cadre.
 */
export default function Astuce({
  texte,
  cote,
  nu,
  children,
}: {
  texte: string;
  cote?: 'debut' | 'fin';
  /**
   * Le contenu est DÉJÀ interactif — un champ, un bouton.
   *
   * Sans ça, l'enveloppe ajoute son propre arrêt de tabulation devant le champ
   * qu'elle explique, et souligne en pointillé une bordure d'`input`. Le
   * survol et le focus du champ suffisent à déclencher l'infobulle : c'est
   * `:focus-within` qui fait le travail.
   */
  nu?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className="astuce"
      data-astuce={texte}
      data-cote={cote}
      data-nu={nu === true ? 'true' : undefined}
      // Un élément qui porte une explication doit pouvoir être atteint au
      // clavier, sinon elle n'existe que pour la souris. Sauf quand il enveloppe
      // déjà un élément focalisable, qui l'atteindra pour lui.
      {...(nu === true ? {} : { tabIndex: 0, role: 'note' as const })}
    >
      {children}
    </span>
  );
}
