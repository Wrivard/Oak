/**
 * Le filtre de la palette de commandes.
 *
 * Pas de correspondance floue. Un « fuzzy match » classe « Diagnostic » devant
 * « Prix » quand on tape `pri`, parce qu'il trouve p-r-i dispersés dedans — et
 * on appuie sur Entrée sur la mauvaise entrée. Dans une palette de dix
 * commandes, la sous-chaîne suffit et ne surprend jamais.
 *
 * Ce qui compte davantage : les ACCENTS et l'initiale. Taper `sante` doit
 * trouver « Santé », et `verif` doit classer « Vérifier » devant une entrée qui
 * contiendrait « vérif » au milieu d'une phrase.
 */

/** Minuscules, sans accents. `Santé` et `sante` deviennent la même chose. */
export function normaliser(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export interface Filtrable {
  /** Ce qui s'affiche, et ce sur quoi on cherche en premier. */
  titre: string;
  /** Section, synonymes, chemin — cherchés aussi, mais moins bien classés. */
  mots?: string | undefined;
}

/**
 * Le score d'une entrée pour une requête, ou `null` si elle ne correspond pas.
 *
 * Plus BAS est meilleur — c'est un rang, pas une note. Le classement suit
 * l'endroit où la correspondance tombe : au début du titre d'abord, ailleurs
 * dans le titre ensuite, dans les mots-clés en dernier.
 */
export function score(item: Filtrable, requete: string): number | null {
  const q = normaliser(requete);
  if (q === '') return 0;

  const titre = normaliser(item.titre);
  const i = titre.indexOf(q);
  if (i === 0) return 0;
  if (i > 0) {
    // Un début de MOT vaut mieux qu'un milieu de mot : « lot » dans « Lots »
    // avant « lot » dans « Envoyer un lot ».
    return titre[i - 1] === ' ' ? 1 : 2;
  }

  const mots = normaliser(item.mots ?? '');
  if (mots !== '' && mots.includes(q)) return 3;

  return null;
}

/** Les entrées qui correspondent, dans l'ordre : meilleur score, puis l'ordre d'origine. */
export function filtrer<T extends Filtrable>(items: readonly T[], requete: string): T[] {
  const notes: { item: T; note: number; rang: number }[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    const note = score(item, requete);
    if (note === null) continue;
    notes.push({ item, note, rang: i });
  }
  notes.sort((a, b) => a.note - b.note || a.rang - b.rang);
  return notes.map((n) => n.item);
}
