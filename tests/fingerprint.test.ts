import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { dhash, hamming, phash } from '../lib/fingerprint/hash.js';
import { embed, EMBED_DIM, l2normalize } from '../lib/fingerprint/embed.js';
import { cardImage } from './fixtures/cards.js';
import { THRESHOLDS } from '../lib/config/thresholds.js';

/**
 * Les quatre propriétés dont dépend le niveau 1 de résolution.
 *
 * Les seuils ne sont pas repris de la spec : ils viennent d'une mesure sur 741
 * paires de cartes distinctes (voir docs/02 §3). La spec disait "deux cartes
 * différentes ont une distance ≥ 20" — c'est faux hachage par hachage, vrai sur
 * la somme des deux.
 */
let charizard: Buffer;
let blastoise: Buffer;

beforeAll(async () => {
  [charizard, blastoise] = await Promise.all([
    cardImage('charizard'),
    cardImage('blastoise'),
  ]);
}, 60_000);

describe('empreintes perceptuelles', () => {
  it('la même image donne le même hash, de façon déterministe', async () => {
    const [p1, p2] = [await phash(charizard), await phash(charizard)];
    const [d1, d2] = [await dhash(charizard), await dhash(charizard)];

    expect(p1).toBe(p2);
    expect(d1).toBe(d2);
    expect(p1).toHaveLength(64);
    expect(d1).toHaveLength(64);
    expect(p1).toMatch(/^[01]{64}$/); // littéral bit(64) Postgres
  });

  it('une image redimensionnée à 80 % reste à une distance ≤ 4', async () => {
    const meta = await sharp(charizard).metadata();
    const smaller = await sharp(charizard)
      .resize(Math.round((meta.width ?? 245) * 0.8))
      .toBuffer();

    expect(hamming(await phash(charizard), await phash(smaller))).toBeLessThanOrEqual(4);
    expect(hamming(await dhash(charizard), await dhash(smaller))).toBeLessThanOrEqual(4);
  });

  it('deux cartes différentes sont séparées par la SOMME des deux hachages', async () => {
    const dp = hamming(await phash(charizard), await phash(blastoise));
    const dd = hamming(await dhash(charizard), await dhash(blastoise));

    // Mesuré sur 741 paires : la somme n'est jamais descendue sous 29, alors que
    // pHash seul descend à 10 (3,4 % des paires sous 20) et dHash à 10 aussi
    // (8,4 % sous 20). C'est pour ça que le niveau 1 trie sur d_p + d_d et non
    // sur un seul hachage.
    expect(dp + dd).toBeGreaterThanOrEqual(20);

    // Marge face au seuil du niveau 1 (phashMax 8 + dhashMax 10 = 18) : deux
    // cartes distinctes doivent rester nettement au-dessus.
    expect(dp + dd).toBeGreaterThan(18);
  });

  it('un embedding a 512 dimensions et une norme de 1,0', async () => {
    const v = await embed(charizard);

    expect(v).toHaveLength(EMBED_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  }, 120_000);

  it('l2normalize refuse un vecteur nul plutôt que de produire des NaN', () => {
    expect(() => l2normalize([0, 0, 0])).toThrow(/nul/);
  });
});

describe('le niveau 1 doit attraper un RE-SCAN de la même carte', () => {
  /**
   * C'est tout le modèle économique : la première occurrence coûte une review,
   * les suivantes doivent être gratuites. Si la variation d'un re-scan dépasse
   * les seuils, le niveau 1 ne se déclenche jamais et le coût marginal ne
   * descend pas — le système continue de marcher, mais il cesse d'être rentable.
   *
   * Ce test est une PORTE : il ne fixe pas les seuils, il vérifie qu'ils
   * laissent encore passer un re-scan réaliste.
   */
  const P = THRESHOLDS.ownHistory.phashMax;
  const D = THRESHOLDS.ownHistory.dhashMax;

  async function distances(base: Buffer, variante: Buffer) {
    return {
      p: hamming(await phash(base), await phash(variante)),
      d: hamming(await dhash(base), await dhash(variante)),
    };
  }

  it('un re-scan réaliste reste sous les deux seuils', async () => {
    // Léger travers, éclairage un peu différent, compression du scanner.
    const base = await cardImage('charizard');
    const rescan = await sharp(base)
      .rotate(0.8, { background: '#000' })
      .modulate({ brightness: 1.04, saturation: 0.97 })
      .blur(0.3)
      .jpeg({ quality: 82 })
      .toBuffer();

    const { p, d } = await distances(base, rescan);
    expect(p).toBeLessThanOrEqual(P);
    expect(d).toBeLessThanOrEqual(D);
  }, 60_000);

  it('LE dHASH EST LA CONTRAINTE, et c’est la rotation qui le pousse', async () => {
    // Mesuré : à 2° de travers, le dHash sort du seuil (11 à 14 pour un budget
    // de 10) alors que le pHash tient encore (6 à 8 pour 8). Le hachage de
    // gradient est plus sensible à la rotation que celui de fréquence.
    //
    // Conséquence d'exploitation : au-delà d'environ un degré et demi de
    // travers dans l'ADF, une carte déjà connue repart en review. Ce test
    // documente la limite plutôt que de prétendre qu'elle n'existe pas.
    const base = await cardImage('blastoise');
    const droit = await sharp(base).rotate(1, { background: '#000' }).jpeg().toBuffer();
    const travers = await sharp(base).rotate(2, { background: '#000' }).jpeg().toBuffer();

    const a = await distances(base, droit);
    const b = await distances(base, travers);

    expect(a.d).toBeLessThanOrEqual(D);
    expect(b.d).toBeGreaterThan(a.d);
  }, 60_000);
});
