import { describe, expect, it } from 'vitest';
import {
  buildQuery,
  summarize,
  type Observation,
} from '../lib/pricing/ebay-comps.js';

/**
 * Agrégation des comparables eBay. Fonctions pures : testables sans réseau,
 * donc testées avant toute intégration (skill money-path).
 *
 * Le total qui compte est TOUJOURS prix + port. Une carte à 0,99 $ avec 4,50 $
 * de port n'est pas une carte à 0,99 $.
 */
const obs = (price: number, ship: number, soldAt?: string): Observation => ({
  totalCents: price + ship,
  priceCents: price,
  shippingCents: ship,
  ...(soldAt ? { soldAt } : {}),
  title: 'test',
  itemId: 'v1|1|0',
});

describe('summarize', () => {
  it('calcule la moyenne sur le TOTAL, pas sur le prix seul', () => {
    // 99 + 450 = 549, et 399 + 0 = 399. Moyenne des totaux = 474.
    // Une moyenne des prix seuls donnerait 249 — soit moitié moins que ce que
    // l'acheteur paie réellement.
    const s = summarize([obs(99, 450), obs(399, 0)]);
    expect(s.averageCents).toBe(474);
  });

  it('rend AUSSI la médiane, et l’écart avec la moyenne est un signal', () => {
    // Une annonce délirante à 200 $ sur une carte à 3 $ : la moyenne explose,
    // la médiane tient. Voir l'annonce à 20000 comme du bruit de recherche
    // plein texte (lot, carte gradée) plutôt que comme le marché.
    const s = summarize([obs(300, 0), obs(310, 0), obs(305, 0), obs(315, 0), obs(20000, 0)]);
    expect(s.medianCents).toBe(310);
    expect(s.averageCents).toBe(4246);
    // Un rapport moyenne/médiane de 13 dit tout : il y a du bruit dans les
    // résultats, et c'est la médiane qu'il faut croire.
    expect(s.averageCents! / s.medianCents!).toBeGreaterThan(10);
  });

  it('rend les bornes et le compte', () => {
    const s = summarize([obs(100, 50), obs(300, 0), obs(200, 25)]);
    expect(s.lowCents).toBe(150);
    expect(s.highCents).toBe(300);
    expect(s.count).toBe(3);
  });

  it('médiane sur un nombre pair : moyenne des deux du milieu', () => {
    const s = summarize([obs(100, 0), obs(200, 0), obs(300, 0), obs(400, 0)]);
    expect(s.medianCents).toBe(250);
  });

  it('sur zéro observation : que des null, jamais zéro', () => {
    // Rendre 0 ferait passer « aucune donnée » pour « gratuit », et le moteur
    // planterait le prix au plancher sans que rien ne proteste.
    const s = summarize([]);
    expect(s.averageCents).toBeNull();
    expect(s.medianCents).toBeNull();
    expect(s.count).toBe(0);
  });

  it('conserve les dates de vente', () => {
    const s = summarize([obs(500, 0, '2026-08-01T00:00:00Z'), obs(600, 0, '2026-08-15T00:00:00Z')]);
    expect(s.observations.map((o) => o.soldAt)).toEqual([
      '2026-08-01T00:00:00Z',
      '2026-08-15T00:00:00Z',
    ]);
  });
});

describe('buildQuery', () => {
  it('inclut le numéro, discriminant plus fiable que le nom', () => {
    expect(buildQuery('Charizard', '4', 102)).toBe('Charizard 4/102');
  });

  it('omet le dénominateur sur une promo', () => {
    expect(buildQuery('Galarian Moltres', 'SWSH284', null)).toBe(
      'Galarian Moltres SWSH284',
    );
  });
});
