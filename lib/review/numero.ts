/**
 * Rapprocher le numéro LU du numéro IMPRIMÉ des candidats.
 *
 * Le cas qui coûte du temps en review, mesuré sur les vrais candidats : cinq
 * lignes qui disent toutes « Blastoise », séparées par un centième de distance
 * CLIP, et dont deux sont le même artwork réimprimé. L'OCR a lu `2/130` ; le
 * candidat n° 2 porte `2/130`. Le système a déjà la réponse, mais il l'affiche
 * à deux endroits différents de l'écran et laisse l'humain faire la comparaison
 * de caractères — quatre-vingt-cinq fois de suite.
 *
 * Ce module fait cette comparaison. Il ne décide rien : il désigne, et l'écran
 * montre POURQUOI il désigne. Le chemin d'auto-résolution du worker n'utilise
 * pas ce module — voir `docs/02-ingest-and-matching.md` §3 pour le filtre
 * déterministe, qui est une autre implémentation, côté serveur, sur la table
 * `cards` entière.
 *
 * Règle d'abstention : s'il y a plusieurs correspondances, il n'y en a AUCUNE.
 * Un indice ambigu est pire qu'un indice absent, parce qu'on lui fait confiance
 * une fois de trop. C'est le même principe que la marge minimum du niveau 2.
 */

export interface CandidatNumerote {
  number?: string | null;
  printedTotal?: number | null;
}

/** Le numérateur et, s'il est présent, le total, extraits d'un numéro écrit. */
export interface NumeroLu {
  /** `2` pour `002/130`, `TG12` pour `TG12/TG30`. Toujours en majuscules. */
  numero: string;
  /** `130` pour `2/130`, `null` pour `SV049` seul. */
  total: string | null;
}

/**
 * Réduit un numéro à sa forme comparable.
 *
 * Les zéros de tête tombent — l'OCR lit `002` là où le catalogue dit `2`, et
 * l'inverse arrive aussi. La casse tombe — `tg12` et `TG12` sont le même
 * numéro. Les espaces autour du `/` tombent : le scanner en produit.
 *
 * Retourne `null` sur ce qui n'a pas la forme d'un numéro plutôt que de
 * renvoyer une chaîne vide qui s'égaliserait avec une autre chaîne vide.
 */
export function lireNumero(brut: string | null | undefined): NumeroLu | null {
  if (typeof brut !== 'string') return null;
  const propre = brut.trim().toUpperCase().replace(/\s*\/\s*/, '/');
  if (propre.length === 0) return null;

  const parts = propre.split('/');
  if (parts.length > 2) return null;

  const numero = normaliserPart(parts[0]);
  if (numero === null) return null;

  const total = parts.length === 2 ? normaliserPart(parts[1]) : null;
  // `12/` a un `/` mais pas de total : la lecture est tronquée, on la rejette
  // plutôt que de la traiter comme `12` seul et de conclure sur une moitié.
  if (parts.length === 2 && total === null) return null;

  return { numero, total };
}

/**
 * Un segment de numéro : lettres facultatives puis chiffres, zéros de tête
 * retirés. `H12`, `SV049`, `007`, `130`. Rejette tout le reste.
 */
function normaliserPart(brut: string | undefined): string | null {
  if (brut === undefined) return null;
  const m = /^([A-Z]*)0*(\d+)([A-Z]?)$/.exec(brut);
  if (!m) return null;
  return `${m[1] ?? ''}${m[2] ?? ''}${m[3] ?? ''}`;
}

/**
 * L'index du SEUL candidat dont le numéro imprimé correspond à ce qui a été lu,
 * ou `null`.
 *
 * Le total compte quand les deux côtés l'ont : `2/102` et `2/130` sont deux
 * cartes différentes, et c'est exactement la paire qui fait perdre du temps.
 * Quand l'OCR n'a pas lu de total, le numérateur seul suffit — mais il doit
 * alors désigner un candidat unique, sinon on s'abstient.
 */
export function candidatDuNumero(
  lu: string | null | undefined,
  candidats: readonly CandidatNumerote[],
): number | null {
  const cible = lireNumero(lu);
  if (cible === null) return null;

  const trouves: number[] = [];
  for (let i = 0; i < candidats.length; i += 1) {
    const c = candidats[i];
    if (c === undefined) continue;
    const sien = lireNumero(c.number);
    if (sien === null || sien.numero !== cible.numero) continue;

    if (cible.total !== null && c.printedTotal !== null && c.printedTotal !== undefined) {
      const sonTotal = lireNumero(String(c.printedTotal));
      if (sonTotal === null || sonTotal.numero !== cible.total) continue;
    }
    trouves.push(i);
  }

  return trouves.length === 1 ? (trouves[0] ?? null) : null;
}
