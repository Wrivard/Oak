import { describe, expect, it } from 'vitest';
import {
  estimateValue,
  median,
  trimOutliers,
} from '../lib/pricing/estimate.js';
import {
  isAnomalousSwing,
  parsePricingConfig,
  roundPsych,
  roundWhole,
  suggestPrice,
  worthPushing,
  type PricingConfig,
} from '../lib/pricing/rules.js';

/**
 * Chemin de l'argent : ces tests bloquent le merge (PROMPTS.md étape 7).
 *
 * Ils figent le tableau de bandes de docs/03 §3 ligne par ligne, plus les cas
 * qui cassent en production : valeur nulle, valeur négative, et les valeurs
 * exactement sur les frontières de bandes.
 */
const CFG: PricingConfig = parsePricingConfig({
  hard_floor: 1.75,
  bands: [
    { up_to: 2.0, mode: 'floor', value: 1.75 },
    { up_to: 5.0, mode: 'mult', value: 1.15, round: 'psych' },
    { up_to: 20.0, mode: 'mult', value: 1.1, round: 'psych' },
    { up_to: 75.0, mode: 'mult', value: 1.05, round: 'psych' },
    { up_to: null, mode: 'mult', value: 1.0, round: 'whole', flag_review: true },
  ],
  condition_mult: { NM: 1.0, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 },
  graded_bypass: true,
  review_threshold: 75.0,
  reprice_delta_pct: 0.05,
  channel_offsets: { ebay: 1.0, tcgplayer: 0.97 },
});

const p = (dollars: number) => Math.round(dollars * 100);

describe('suggestPrice — le tableau de docs/03 §3, ligne par ligne', () => {
  it.each([
    ['0,50 $  → plancher', p(0.5), p(1.75)],
    ['1,90 $  → plancher', p(1.9), p(1.75)],
    ['3,00 $  → ×1,15', p(3.0), p(3.49)],
    ['25,00 $ → ×1,05', p(25.0), p(26.49)],
    ['120,00 $ → ×1,00 + flag', p(120.0), p(120.0)],
  ])('%s', (_label, valueCents, expected) => {
    expect(suggestPrice(valueCents, 'NM', CFG, 'ebay').priceCents).toBe(expected);
  });

  it('la ligne à 120 $ est flaggée pour review', () => {
    expect(suggestPrice(p(120), 'NM', CFG, 'ebay').flagReview).toBe(true);
  });

  it('une carte bon marché n’est pas flaggée', () => {
    expect(suggestPrice(p(3), 'NM', CFG, 'ebay').flagReview).toBe(false);
  });
});

describe('suggestPrice — frontières de bandes', () => {
  // La borne haute est INCLUSIVE : `adjusted <= b.up_to`. Une erreur d'un cent
  // ici fait basculer une carte d'une bande à l'autre.
  it('2,00 $ pile reste dans la bande plancher', () => {
    expect(suggestPrice(p(2.0), 'NM', CFG, 'ebay').band.mode).toBe('floor');
  });

  it('2,01 $ bascule dans la bande ×1,15', () => {
    const s = suggestPrice(p(2.01), 'NM', CFG, 'ebay');
    expect(s.band.value).toBe(1.15);
  });

  it('5,00 $ pile reste dans la bande ×1,15', () => {
    expect(suggestPrice(p(5.0), 'NM', CFG, 'ebay').band.value).toBe(1.15);
  });

  it('5,01 $ bascule dans la bande ×1,10', () => {
    expect(suggestPrice(p(5.01), 'NM', CFG, 'ebay').band.value).toBe(1.1);
  });

  it('75,00 $ pile reste dans la bande ×1,05', () => {
    expect(suggestPrice(p(75.0), 'NM', CFG, 'ebay').band.value).toBe(1.05);
  });

  it('75,01 $ tombe dans la dernière bande, sans plafond', () => {
    const s = suggestPrice(p(75.01), 'NM', CFG, 'ebay');
    expect(s.band.up_to).toBeNull();
    expect(s.flagReview).toBe(true);
  });
});

describe('suggestPrice — cas dégénérés', () => {
  it('une valeur de zéro donne le plancher dur, jamais zéro', () => {
    expect(suggestPrice(0, 'NM', CFG, 'ebay').priceCents).toBe(p(1.75));
  });

  it('une valeur NÉGATIVE est traitée comme zéro, pas propagée', () => {
    // Une source qui renvoie -500 est une anomalie. Publier un prix négatif ou
    // laisser la valeur traverser le calcul serait pire que de plancher.
    expect(suggestPrice(-500, 'NM', CFG, 'ebay').priceCents).toBe(p(1.75));
  });

  it('refuse une valeur non finie plutôt que de produire NaN', () => {
    expect(() => suggestPrice(Number.NaN, 'NM', CFG, 'ebay')).toThrow(/non finie/);
    expect(() => suggestPrice(Number.POSITIVE_INFINITY, 'NM', CFG, 'ebay')).toThrow();
  });

  it('le prix n’est jamais sous le plancher dur, quelle que soit la condition', () => {
    for (const c of ['NM', 'LP', 'MP', 'HP', 'DMG'] as const) {
      const s = suggestPrice(p(0.1), c, CFG, 'ebay');
      expect(s.priceCents).toBeGreaterThanOrEqual(p(1.75));
    }
  });
});

describe('suggestPrice — condition et canal', () => {
  it('la condition réduit la valeur avant la sélection de bande', () => {
    // 25 $ en MP → 17,50 $ ajusté → bande ×1,10, pas ×1,05.
    expect(suggestPrice(p(25), 'MP', CFG, 'ebay').band.value).toBe(1.1);
  });

  it('l’offset TCGplayer positionne sous eBay', () => {
    const ebay = suggestPrice(p(50), 'NM', CFG, 'ebay').priceCents;
    const tcg = suggestPrice(p(50), 'NM', CFG, 'tcgplayer').priceCents;
    expect(tcg).toBeLessThan(ebay);
  });

  it('l’offset ne fait PAS changer de bande', () => {
    // Sélectionner la bande après l'offset ferait basculer des cartes selon le
    // canal, ce que la grille ne décrit pas.
    const a = suggestPrice(p(5), 'NM', CFG, 'ebay');
    const b = suggestPrice(p(5), 'NM', CFG, 'tcgplayer');
    expect(a.band.value).toBe(b.band.value);
  });

  it('une condition absente de la config crie au lieu de produire NaN', () => {
    const broken = { ...CFG, condition_mult: { NM: 1.0 } };
    expect(() => suggestPrice(p(10), 'LP', broken, 'ebay')).toThrow(/condition_mult/);
  });
});

describe('arrondis', () => {
  it.each([
    [p(3.45), p(3.49)],
    [p(3.0), p(3.49)],
    [p(3.49), p(3.49)],
    [p(3.5), p(3.99)],
    [p(3.99), p(3.99)],
    [p(4.0), p(4.49)],
    [p(26.25), p(26.49)],
  ])('psych %i → %i', (input, expected) => {
    expect(roundPsych(input)).toBe(expected);
  });

  it('whole arrondit au dollar', () => {
    expect(roundWhole(p(120.0))).toBe(p(120));
    expect(roundWhole(p(120.4))).toBe(p(120));
    expect(roundWhole(p(120.6))).toBe(p(121));
  });
});

describe('config', () => {
  it('refuse une config sans bande finale ouverte', () => {
    expect(() =>
      parsePricingConfig({
        ...CFG,
        bands: [{ up_to: 2.0, mode: 'floor', value: 1.75 }],
      }),
    ).toThrow(/up_to = null/);
  });

  it('refuse une config malformée plutôt que de produire des prix nuls', () => {
    expect(() => parsePricingConfig({ hard_floor: 'gratuit' })).toThrow(/invalide/);
    expect(() => parsePricingConfig(null)).toThrow(/invalide/);
  });
});

describe('estimateValue', () => {
  it('mélange les trois sources dès 3 comps', () => {
    const e = estimateValue({
      ebaySold: [p(10), p(11), p(12)],
      tcgMarket: p(9),
      tcgMid: p(8),
    });
    expect(e.method).toBe('blended');
    expect(e.nComps).toBe(3);
    expect(e.valueCents).not.toBeNull();
  });

  it('utilise la MÉDIANE, qu’une vente aberrante ne déplace pas', () => {
    // Lot mal titré à 200 $ sur une carte à 3 $ : la moyenne exploserait.
    const sansAberrante = estimateValue({ ebaySold: [p(3), p(3), p(3)], tcgMarket: p(3) });
    const avecAberrante = estimateValue({
      ebaySold: [p(3), p(3), p(3), p(200)],
      tcgMarket: p(3),
    });
    expect(avecAberrante.valueCents).toBe(sansAberrante.valueCents);
  });

  it('retombe sur TCGplayer seul sous 3 comps', () => {
    expect(estimateValue({ ebaySold: [p(10)], tcgMarket: p(9) }).method).toBe('tcg_only');
  });

  it('gère un market null sans planter, avec fallback Cardmarket', () => {
    // Un null non gardé qui plante un batch de 1 700 cartes à 3 h du matin,
    // c'est la nuit du propriétaire (docs/03 §1).
    const e = estimateValue({ tcgMarket: null, tcgMid: null, cmTrend: p(4) });
    expect(e.method).toBe('cardmarket_fallback');
    expect(e.valueCents).toBe(p(4));
  });

  it('signale le fallback Cardmarket comme tel, pour qu’il soit gardé en aval', () => {
    // Cardmarket est en EUROS. Le handler refuse de publier sur cette seule base
    // — mesuré: écarts de 4,7x et 35x contre TCGplayer. estimateValue rend la
    // valeur, mais la MÉTHODE est ce qui permet de la refuser plus haut.
    expect(estimateValue({ tcgMarket: null, cmTrend: p(4) }).method).toBe(
      'cardmarket_fallback',
    );
  });

  it('sans aucune source : no_data, et AUCUN prix', () => {
    const e = estimateValue({});
    expect(e.method).toBe('no_data');
    expect(e.valueCents).toBeNull();
  });

  it('un market null avec des comps insuffisants ne fabrique pas de valeur', () => {
    const e = estimateValue({ ebaySold: [p(10), p(11)], tcgMarket: null });
    expect(e.method).toBe('no_data');
    expect(e.valueCents).toBeNull();
  });

  it('écrit toujours un breakdown exploitable', () => {
    expect(estimateValue({ tcgMarket: p(5) }).breakdown['method']).toBe('tcg_only');
    expect(estimateValue({}).breakdown['method']).toBe('no_data');
  });
});

describe('median et trimOutliers', () => {
  it('median rend null sur une liste vide', () => {
    expect(median([])).toBeNull();
  });

  it('trimOutliers ne touche à rien sous 4 valeurs', () => {
    // Un IQR sur 3 points ne veut rien dire.
    expect(trimOutliers([1, 100, 3])).toHaveLength(3);
  });

  it('trimOutliers retire une aberrante franche', () => {
    const kept = trimOutliers([300, 310, 305, 295, 20000]);
    expect(kept).not.toContain(20000);
    expect(kept).toHaveLength(4);
  });
});

describe('garde-fous de repricing', () => {
  it('un mouvement de plus de 40 % est une anomalie', () => {
    expect(isAnomalousSwing(p(10), p(15))).toBe(true);
    expect(isAnomalousSwing(p(10), p(5))).toBe(true);
    expect(isAnomalousSwing(p(10), p(13))).toBe(false);
  });

  it('un prix qui passe en centimes est attrapé', () => {
    // Le scénario exact de docs/03 §5 : une source renvoie des centimes.
    expect(isAnomalousSwing(p(20), 20)).toBe(true);
  });

  it('un premier prix n’est jamais une anomalie', () => {
    expect(isAnomalousSwing(null, p(50))).toBe(false);
  });

  it('un delta sous reprice_delta_pct ne se pousse pas', () => {
    expect(worthPushing(p(10), p(10.2), CFG)).toBe(false);
    expect(worthPushing(p(10), p(11), CFG)).toBe(true);
    expect(worthPushing(null, p(10), CFG)).toBe(true);
  });
});
