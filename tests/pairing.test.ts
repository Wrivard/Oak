import { describe, expect, it } from 'vitest';
import {
  backCoherence,
  BACK_SIMILARITY_MAX,
  HEALTHY_BACK_SHARE,
  pairPages,
  type Page,
} from '../lib/ingest/pairing.js';
import { hamming } from '../lib/fingerprint/hash.js';

/**
 * Appariement recto/verso. Voir docs/02-ingest-and-matching.md §1.
 *
 * La position apparie, l'empreinte vérifie. Ce qu'on cherche à ne JAMAIS laisser
 * passer : une page perdue qui décale tout le lot, chaque carte héritant du dos
 * de la suivante — en silence, et on grade la mauvaise carte.
 */

/** Un dos : le même motif à chaque scan, à quelques bits de bruit près. */
const BACK = '1'.repeat(20) + '0'.repeat(24) + '1'.repeat(20);

function noisy(bits: number): string {
  const chars = [...BACK];
  for (let i = 0; i < bits; i++) chars[i * 5] = chars[i * 5] === '1' ? '0' : '1';
  return chars.join('');
}

/** Un recto : chaque carte est différente. */
function front(seed: number): string {
  let state = (seed * 2654435761) >>> 0;
  let s = '';
  for (let i = 0; i < 64; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    s += (state >>> 16) & 1 ? '1' : '0';
  }
  return s;
}

const page = (index: number, phash: string): Page => ({
  index,
  path: `image${String(index).padStart(4, '0')}.jpg`,
  phash,
});

/** Un lot duplex bien formé : recto, verso, recto, verso… */
function duplex(cards: number): Page[] {
  const pages: Page[] = [];
  for (let c = 0; c < cards; c++) {
    pages.push(page(c * 2 + 1, front(c + 1)));
    pages.push(page(c * 2 + 2, noisy(c % 3)));
  }
  return pages;
}

describe('la fixture elle-même', () => {
  it('les rectos sont dispersés, les dos sont groupés', () => {
    // Une fixture qui ne reproduit pas ces deux propriétés testerait autre chose
    // que ce qu'on croit — c'est arrivé deux fois sur ce module.
    for (let a = 1; a <= 8; a++) {
      for (let b = a + 1; b <= 8; b++) {
        expect(hamming(front(a), front(b))).toBeGreaterThan(BACK_SIMILARITY_MAX);
      }
    }
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) {
        expect(hamming(noisy(a), noisy(b))).toBeLessThanOrEqual(BACK_SIMILARITY_MAX);
      }
    }
  });
});

describe('pairPages — duplex', () => {
  it('apparie image1 avec image2, image3 avec image4, etc.', () => {
    const res = pairPages(duplex(5), 'duplex');

    expect(res.pairs.map((p) => [p.front.index, p.back?.index ?? null])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
    ]);
    expect(res.alternanceSaine).toBe(true);
    expect(res.anomalies).toEqual([]);
  });

  it('12 pages donnent 6 cartes, pas 12', () => {
    expect(pairPages(duplex(6), 'duplex').pairs).toHaveLength(6);
  });

  it('DÉTECTE un lot décalé par une page perdue', () => {
    // Le scénario redouté : le verso de la carte 2 manque. L'appariement
    // positionnel donne alors recto3+recto4, recto5+dos6… Sans le contrôle
    // d'empreinte, personne ne le verrait.
    const pages = duplex(6).filter((p) => p.index !== 4);
    const res = pairPages(pages, 'duplex');

    expect(res.alternanceSaine).toBe(false);
    expect(res.anomalies.some((a) => a.reason.includes('décalé'))).toBe(true);
  });

  it('un lot sain ne déclenche aucune fausse alerte', () => {
    // Un garde-fou qui crie tout le temps est un garde-fou qu'on désactive.
    for (const n of [2, 5, 10, 25]) {
      expect(pairPages(duplex(n), 'duplex').alternanceSaine).toBe(true);
    }
  });

  it('un nombre impair de pages laisse la dernière carte sans verso', () => {
    // Le recto porte l'identité : la carte reste exploitable, mais c'est dit.
    const pages = [...duplex(3), page(7, front(99))];
    const res = pairPages(pages, 'duplex');

    expect(res.pairs).toHaveLength(4);
    expect(res.pairs[3]?.back).toBeNull();
    expect(res.anomalies.some((a) => a.reason.includes('impair'))).toBe(true);
  });
});

describe('backCoherence', () => {
  it('vaut 1 quand tous les dos se ressemblent', () => {
    expect(backCoherence([page(2, noisy(0)), page(4, noisy(1)), page(6, noisy(2))])).toBe(1);
  });

  it('s’effondre quand des rectos se glissent parmi les dos', () => {
    const melange = [
      page(2, noisy(0)),
      page(4, front(1)),
      page(6, front(2)),
      page(8, front(3)),
    ];
    expect(backCoherence(melange)).toBeLessThan(HEALTHY_BACK_SHARE);
  });

  it('juge sur le représentant le plus central, pas sur le premier', () => {
    // Si l'intrus est en tête, comparer tout le monde au premier inverserait le
    // verdict : trois vrais dos passeraient pour incohérents.
    const intrusEnTete = [
      page(2, front(1)),
      page(4, noisy(0)),
      page(6, noisy(1)),
      page(8, noisy(2)),
    ];
    expect(backCoherence(intrusEnTete)).toBeGreaterThanOrEqual(0.7);
  });

  it('ne se prononce pas sur une seule page', () => {
    expect(backCoherence([page(2, noisy(0))])).toBe(1);
  });
});

describe('pairPages — recto seul', () => {
  it('traite chaque page comme une carte', () => {
    const pages = Array.from({ length: 4 }, (_, i) => page(i + 1, front(i + 1)));
    const res = pairPages(pages, 'front_only');
    expect(res.pairs).toHaveLength(4);
    expect(res.pairs.every((p) => p.back === null)).toBe(true);
  });

  it('ne vérifie rien : le mode est un choix explicite', () => {
    const res = pairPages(duplex(3), 'front_only');
    expect(res.pairs).toHaveLength(6);
    expect(res.anomalies).toEqual([]);
  });
});
