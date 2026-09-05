import { describe, expect, it } from 'vitest';
import { extractPrices, toPriceSources, type ApiCard } from '../lib/pricing/sources.js';
import { estimateValue } from '../lib/pricing/estimate.js';

/**
 * Extraction des points de prix TCGplayer.
 *
 * Le point qui compte : **on ne substitue jamais un autre printing**. Cette
 * fonction retombait sur le premier printing disponible quand celui demandé
 * manquait — un SKU `reverseHolofoil` dont l'API n'a que `normal` était donc
 * prixé au prix du normal, publié, vendu. C'est exactement l'erreur à 5-20x que
 * tout le reste du système refuse.
 *
 * C'est du chemin de l'argent, donc c'est testé.
 */
function carte(prices: Record<string, unknown>, cardmarket?: number): ApiCard {
  return {
    id: 'base1-4',
    tcgplayer: { url: 'https://tcg/x', updatedAt: '2026-09-04', prices: prices as never },
    ...(cardmarket === undefined
      ? {}
      : { cardmarket: { prices: { trendPrice: cardmarket } } }),
  };
}

describe('extractPrices', () => {
  it('lit le printing demandé', () => {
    const f = extractPrices(
      carte({ normal: { market: 1.25, mid: 1.5, low: 0.9, high: 4 } }),
      'normal',
    );
    expect(f.tcgMarket).toBe(125);
    expect(f.tcgMid).toBe(150);
    expect(f.tcgLow).toBe(90);
    expect(f.tcgHigh).toBe(400);
    expect(f.raw['printing_utilise']).toBe('normal');
    expect(f.raw['printing_absent']).toBe(false);
  });

  it('NE SUBSTITUE PAS UN AUTRE PRINTING — 5 à 20x d’écart', () => {
    // Le cas réel : un lot de reverse holo, une carte dont l'API n'a que le
    // normal. L'ancien comportement publiait le reverse au prix du normal.
    const f = extractPrices(
      carte({ normal: { market: 0.4, mid: 0.5 } }),
      'reverseHolofoil',
    );
    expect(f.tcgMarket).toBeNull();
    expect(f.tcgMid).toBeNull();
    expect(f.raw['printing_utilise']).toBeNull();
    expect(f.raw['printing_absent']).toBe(true);
    expect(f.raw['printings_disponibles']).toEqual(['normal']);
  });

  it('un printing absent ne produit AUCUN prix publiable', () => {
    // Bout en bout : pas de printing → pas de valeur → la carte part en review
    // au lieu d'être publiée à un prix emprunté à un autre variant.
    const f = extractPrices(carte({ normal: { market: 0.4 } }), 'holofoil');
    const e = estimateValue(toPriceSources(f, []));
    expect(e.valueCents).toBeNull();
  });

  it('un printing absent avec Cardmarket reste non publiable', () => {
    // Cardmarket seul est en EUROS non convertis : `cardmarket_fallback` envoie
    // en review, il ne publie pas non plus.
    const f = extractPrices(carte({ normal: { market: 0.4 } }, 3.92), 'holofoil');
    const e = estimateValue(toPriceSources(f, []));
    expect(e.method).toBe('cardmarket_fallback');
  });

  it('garde le null de `market` sans tomber', () => {
    // Fréquent, pas exceptionnel : aucune annonce active sur ce printing. Un
    // null non gardé qui plante un batch de 1 700 cartes coûte une nuit.
    const f = extractPrices(carte({ normal: { market: null, mid: 2.1 } }), 'normal');
    expect(f.tcgMarket).toBeNull();
    expect(f.tcgMid).toBe(210);
  });

  it('refuse les valeurs absurdes plutôt que de les arrondir', () => {
    const f = extractPrices(
      carte({ normal: { market: -1, mid: Number.NaN, low: Number.POSITIVE_INFINITY } }),
      'normal',
    );
    expect(f.tcgMarket).toBeNull();
    expect(f.tcgMid).toBeNull();
    expect(f.tcgLow).toBeNull();
  });

  it('convertit en CENTS ENTIERS, jamais en flottants', () => {
    // Invariant : montants en cents entiers en TS, jamais de float cumulatif.
    const f = extractPrices(carte({ normal: { market: 0.1 + 0.2 } }), 'normal');
    expect(f.tcgMarket).toBe(30);
    expect(Number.isInteger(f.tcgMarket)).toBe(true);
  });

  it('une carte sans bloc tcgplayer ne casse rien', () => {
    const f = extractPrices({ id: 'x' }, 'normal');
    expect(f.tcgMarket).toBeNull();
    expect(f.tcgplayerUrl).toBeNull();
    expect(f.raw['printings_disponibles']).toEqual([]);
    expect(f.raw['printing_absent']).toBe(true);
  });

  it('liste tous les printings disponibles pour la review', () => {
    // « Tu as demandé reverseHolofoil, l'API n'a que ça » doit se lire d'un
    // coup d'oeil : c'est ce qui dit si le lot a été envoyé au mauvais variant.
    const f = extractPrices(
      carte({ normal: { market: 1 }, holofoil: { market: 9 } }),
      'reverseHolofoil',
    );
    expect(f.raw['printings_disponibles']).toEqual(['normal', 'holofoil']);
  });
});

describe('toPriceSources', () => {
  it('transmet les comparables eBay tels quels', () => {
    const f = extractPrices(carte({ normal: { market: 5, mid: 6 } }, 4), 'normal');
    const s = toPriceSources(f, [100, 200, 300]);
    expect(s.ebaySold).toEqual([100, 200, 300]);
    expect(s.tcgMarket).toBe(500);
    expect(s.tcgMid).toBe(600);
    expect(s.cmTrend).toBe(400);
  });
});
