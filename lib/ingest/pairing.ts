import { hamming, type Bits64 } from '../fingerprint/hash.js';

/**
 * Appariement recto/verso d'un lot scanné en duplex.
 *
 * Un scanner duplex sort `image0001` (recto), `image0002` (verso),
 * `image0003` (recto)… **La position décide de l'appariement** : c'est ce que le
 * matériel produit, et c'est simple.
 *
 * L'empreinte, elle, ne décide pas — elle **vérifie**. Le dos d'une carte
 * Pokémon est constant : si les pages paires ne se ressemblent pas entre elles,
 * c'est qu'une page a été perdue en route et que tout le lot est décalé d'un
 * cran. Sans ce contrôle, chaque carte hériterait du dos de la suivante, en
 * silence, et on graderait la mauvaise carte.
 *
 * Une première version faisait l'inverse — regrouper par ressemblance pour
 * DÉDUIRE les dos. Trop fragile : sur des images peu détaillées le regroupement
 * se trompe, et il compliquait un problème que la position résout.
 */

/** Deux dos du même lot restent très proches, même avec le bruit du scanner. */
export const BACK_SIMILARITY_MAX = 12;

/**
 * Part des pages paires qui doivent se ressembler pour que l'alternance soit
 * jugée saine. En dessous, on refuse d'apparier plutôt que de produire des
 * paires fausses.
 */
export const HEALTHY_BACK_SHARE = 0.8;

export interface Page {
  /** Rang dans le lot, à partir de 1. */
  index: number;
  path: string;
  phash: Bits64;
}

export type PairMode = 'front_only' | 'duplex';

export interface Pair {
  front: Page;
  back: Page | null;
}

export interface PairingResult {
  pairs: Pair[];
  /** Ce qui cloche, jamais avalé. */
  anomalies: { index: number; path: string; reason: string }[];
  /** L'alternance recto/verso tient-elle sur l'ensemble du lot ? */
  alternanceSaine: boolean;
  /** Part des pages paires cohérentes entre elles, 0 à 1. */
  coherenceDos: number;
}

/**
 * Les pages paires se ressemblent-elles entre elles ?
 *
 * On compare chacune à la MÉDIANE du groupe plutôt qu'à la première : si c'est
 * justement la première qui est une intruse, la comparer aux autres donnerait un
 * verdict inversé.
 */
export function backCoherence(evens: readonly Page[]): number {
  if (evens.length < 2) return 1;

  // Le représentant est la page qui ressemble le plus à toutes les autres.
  let bestScore = -1;
  let representative = evens[0] as Page;
  for (const candidate of evens) {
    const score = evens.filter(
      (p) => hamming(p.phash, candidate.phash) <= BACK_SIMILARITY_MAX,
    ).length;
    if (score > bestScore) {
      bestScore = score;
      representative = candidate;
    }
  }

  return bestScore / evens.length;
}

/**
 * Apparie les pages. En duplex : impaire = recto, paire = verso qui la suit.
 */
export function pairPages(pages: readonly Page[], mode: PairMode): PairingResult {
  const ordered = [...pages].sort((a, b) => a.index - b.index);

  if (mode === 'front_only') {
    return {
      pairs: ordered.map((front) => ({ front, back: null })),
      anomalies: [],
      alternanceSaine: true,
      coherenceDos: 0,
    };
  }

  const pairs: Pair[] = [];
  const anomalies: PairingResult['anomalies'] = [];

  for (let i = 0; i < ordered.length; i += 2) {
    const front = ordered[i] as Page;
    const back = ordered[i + 1] ?? null;

    if (!back) {
      // Nombre impair de pages : la dernière carte n'a pas de dos. Elle reste
      // exploitable — le recto porte l'identité — mais c'est signalé.
      anomalies.push({
        index: front.index,
        path: front.path,
        reason: 'nombre impair de pages : dernière carte sans verso',
      });
    }
    pairs.push({ front, back });
  }

  // La vérification. Les pages paires devraient toutes être des dos.
  const evens = pairs.map((p) => p.back).filter((b): b is Page => b !== null);
  const coherence = backCoherence(evens);
  const saine = coherence >= HEALTHY_BACK_SHARE;

  if (!saine && evens.length >= 2) {
    // C'est l'alerte qui compte : un décalage d'une page fait que chaque carte
    // reçoit le dos de la suivante, et rien ne le montrerait sans ce contrôle.
    anomalies.push({
      index: 0,
      path: '',
      reason:
        `alternance recto/verso douteuse : seulement ` +
        `${Math.round(coherence * 100)} % des pages paires se ressemblent. ` +
        `Une page a probablement été perdue et tout le lot est décalé. ` +
        `Vérifie le lot avant de valider les cartes.`,
    });
  }

  return { pairs, anomalies, alternanceSaine: saine, coherenceDos: coherence };
}
