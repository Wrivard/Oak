/**
 * Combien de temps une voie attend avant de redemander du travail.
 *
 * Le problème, compté : neuf voies — quatre `fingerprint`, deux `match`, une
 * pour chacun des trois autres types — interrogeaient la base toutes les
 * 500 ms, chacune de son côté. Dix-huit requêtes par seconde en permanence,
 * pour rien, sur une base distante dont le pool ne compte que cinq clients par
 * processus.
 *
 * Ce n'est pas qu'une question de quota : ces requêtes à vide se disputent les
 * mêmes cinq connexions que le travail réel. Une voie qui dort libère une
 * place pour une voie qui travaille.
 *
 * Le recul est donc PROGRESSIF, et il repart à zéro dès qu'un job est trouvé —
 * un lot arrive rarement seul, et la carte suivante ne doit pas attendre. Le
 * plafond est par type : `fingerprint`, `match` et `pair_upload` sont sur le
 * chemin qu'un humain regarde, les autres sont du travail de fond.
 */

/** Première attente, et celle qui suit tout job trouvé. */
export const ATTENTE_MIN_MS = 500;

/**
 * Le pas de croissance. 1,6 met une dizaine de secondes à atteindre un plafond
 * de deux secondes : assez lent pour qu'une pause entre deux lots ne coûte
 * rien, assez rapide pour qu'une nuit d'inactivité ne coûte pas non plus.
 */
const FACTEUR = 1.6;

/**
 * L'attente suivante après une réclamation vide.
 *
 * Bornée au plafond du type. Le résultat est arrondi à la milliseconde : un
 * `setTimeout` sur 819,2 ms n'a pas de sens et rend les journaux illisibles.
 */
export function prochaineAttente(actuelle: number, plafondMs: number): number {
  const plafond = Math.max(plafondMs, ATTENTE_MIN_MS);
  const suivante = Math.round(Math.max(actuelle, ATTENTE_MIN_MS) * FACTEUR);
  return Math.min(suivante, plafond);
}
