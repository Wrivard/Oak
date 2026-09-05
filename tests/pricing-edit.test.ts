import { describe, expect, it } from 'vitest';
import {
  ajouterBande,
  changerBorne,
  changerMode,
  retirerBande,
  trierBandes,
} from '../lib/pricing/edit.js';
import { parsePricingConfig, suggestPrice, type PricingConfig } from '../lib/pricing/rules.js';

/**
 * Les manipulations de bandes de l'éditeur de règles.
 *
 * Elles portent un invariant que `parsePricingConfig` refuse de voir violé :
 * **la dernière bande n'a pas de plafond**. Sans elle, une carte plus chère que
 * la dernière borne ne tombe dans aucune bande, `find` rend `undefined`, et le
 * prix est calculé sur du vide — en production, sur les cartes qui valent le
 * plus cher.
 *
 * Un bouton « ajouter » qui empilerait naïvement une bande à la fin casserait ça
 * d'un clic, et l'écran continuerait de paraître normal. D'où ces tests.
 */
const BASE: PricingConfig = {
  hard_floor: 1.75,
  bands: [
    { up_to: 2, mode: 'floor', value: 1.75 },
    { up_to: 5, mode: 'mult', value: 1.15, round: 'psych' },
    { up_to: 20, mode: 'mult', value: 1.1, round: 'psych' },
    { up_to: null, mode: 'mult', value: 1, round: 'whole', flag_review: true },
  ],
  condition_mult: { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.3 },
  graded_bypass: true,
  review_threshold: 75,
  reprice_delta_pct: 0.05,
  channel_offsets: { ebay: 1, tcgplayer: 0.97 },
};

/** Toute sortie de l'éditeur doit rester acceptable par le validateur. */
function valide(cfg: PricingConfig): PricingConfig {
  return parsePricingConfig(JSON.parse(JSON.stringify(cfg)));
}

describe('ajouterBande', () => {
  it('N’AJOUTE JAMAIS APRÈS LA BANDE SANS PLAFOND', () => {
    const next = ajouterBande(BASE);
    expect(next.bands[next.bands.length - 1]?.up_to).toBeNull();
    expect(() => valide(next)).not.toThrow();
  });

  it('reste valide après dix ajouts d’affilée', () => {
    let cfg = BASE;
    for (let i = 0; i < 10; i++) cfg = ajouterBande(cfg);
    expect(cfg.bands).toHaveLength(BASE.bands.length + 10);
    expect(cfg.bands[cfg.bands.length - 1]?.up_to).toBeNull();
    expect(() => valide(cfg)).not.toThrow();
  });

  it('ne crée pas deux bandes de même borne', () => {
    // Deux bandes de même borne en rendent une inatteignable, sans erreur.
    const next = ajouterBande(BASE);
    const bornes = next.bands.map((b) => b.up_to).filter((b): b is number => b !== null);
    expect(new Set(bornes).size).toBe(bornes.length);
  });

  it('ne touche pas la config d’origine', () => {
    const avant = JSON.stringify(BASE);
    ajouterBande(BASE);
    expect(JSON.stringify(BASE)).toBe(avant);
  });
});

describe('retirerBande', () => {
  it('REFUSE de retirer la bande sans plafond', () => {
    const next = retirerBande(BASE, BASE.bands.length - 1);
    expect(next.bands).toHaveLength(BASE.bands.length);
    expect(next.bands[next.bands.length - 1]?.up_to).toBeNull();
  });

  it('retire une bande du milieu', () => {
    const next = retirerBande(BASE, 1);
    expect(next.bands.map((b) => b.up_to)).toEqual([2, 20, null]);
    expect(() => valide(next)).not.toThrow();
  });

  it('ignore un index hors bornes', () => {
    expect(retirerBande(BASE, 99).bands).toHaveLength(BASE.bands.length);
    expect(retirerBande(BASE, -1).bands).toHaveLength(BASE.bands.length);
  });

  it('laisse une config à une seule bande utilisable', () => {
    let cfg = BASE;
    while (cfg.bands.length > 1) cfg = retirerBande(cfg, 0);
    expect(cfg.bands).toHaveLength(1);
    expect(() => valide(cfg)).not.toThrow();
    // Et elle price toujours, à n'importe quel niveau.
    expect(suggestPrice(500_00, 'NM', valide(cfg), 'ebay').priceCents).toBeGreaterThan(0);
  });
});

describe('changerBorne', () => {
  it('REMET L’ORDRE — une borne plus basse que la précédente serait inatteignable', () => {
    // Passer la deuxième bande de 5 $ à 1 $ la placerait après une bande qui
    // couvre déjà tout ce qui est sous 2 $ : elle ne serait jamais choisie.
    const next = changerBorne(BASE, 1, 1);
    expect(next.bands.map((b) => b.up_to)).toEqual([1, 2, 20, null]);
    expect(() => valide(next)).not.toThrow();
  });

  it('garde la bande sans plafond en dernier même après un tri', () => {
    const next = changerBorne(BASE, 2, 0.5);
    expect(next.bands[next.bands.length - 1]?.up_to).toBeNull();
  });

  it('refuse une borne nulle ou négative', () => {
    // Une bande jusqu'à 0 $ ne couvre rien.
    expect(changerBorne(BASE, 0, 0).bands[0]?.up_to).toBe(0.01);
    expect(changerBorne(BASE, 0, -5).bands[0]?.up_to).toBe(0.01);
  });

  it('ne fait rien sur la bande sans plafond', () => {
    const next = changerBorne(BASE, BASE.bands.length - 1, 100);
    expect(next.bands[next.bands.length - 1]?.up_to).toBeNull();
  });
});

describe('changerMode', () => {
  it('RÉINITIALISE LA VALEUR — 1,15 en plancher publierait à 1,15 $', () => {
    // Un multiplicateur et un plancher ne vivent pas dans les mêmes ordres de
    // grandeur. Garder la valeur ferait basculer toute une bande sous le
    // plancher dur sans que rien ne le signale.
    const next = changerMode(BASE, 1, 'floor');
    expect(next.bands[1]?.mode).toBe('floor');
    expect(next.bands[1]?.value).toBe(BASE.hard_floor);
  });

  it('repasse en multiplicateur avec une valeur de multiplicateur', () => {
    const next = changerMode(changerMode(BASE, 0, 'mult'), 0, 'mult');
    expect(next.bands[0]?.value).toBe(1.1);
  });

  it('reste valide dans les deux sens', () => {
    for (const i of [0, 1, 2, 3]) {
      expect(() => valide(changerMode(BASE, i, 'floor'))).not.toThrow();
      expect(() => valide(changerMode(BASE, i, 'mult'))).not.toThrow();
    }
  });
});

describe('trierBandes', () => {
  it('met la bande sans plafond en dernier, d’où qu’elle vienne', () => {
    const melange = [
      { up_to: null, mode: 'mult' as const, value: 1 },
      { up_to: 20, mode: 'mult' as const, value: 1.1 },
      { up_to: 2, mode: 'floor' as const, value: 1.75 },
    ];
    expect(trierBandes(melange).map((b) => b.up_to)).toEqual([2, 20, null]);
  });

  it('ne modifie pas le tableau reçu', () => {
    const src = [...BASE.bands];
    trierBandes(src);
    expect(src).toEqual(BASE.bands);
  });
});

describe('le prix reste calculable après édition', () => {
  it('à tous les niveaux, après une suite d’opérations', () => {
    // Le vrai risque n'est pas qu'une opération casse : c'est qu'une suite
    // d'opérations laisse une config qui passe la validation et price mal.
    let cfg = BASE;
    cfg = ajouterBande(cfg);
    cfg = changerMode(cfg, 1, 'floor');
    cfg = changerBorne(cfg, 2, 3);
    cfg = retirerBande(cfg, 0);
    cfg = ajouterBande(cfg);

    const valide_ = valide(cfg);
    for (const cents of [1, 100, 199, 500, 2000, 7500, 50_000]) {
      const s = suggestPrice(cents, 'NM', valide_, 'ebay');
      expect(s.priceCents).toBeGreaterThanOrEqual(Math.round(valide_.hard_floor * 100));
      expect(Number.isFinite(s.priceCents)).toBe(true);
    }
  });
});
