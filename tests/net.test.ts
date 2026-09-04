import { describe, expect, it } from 'vitest';
import { formatCents, netAfterFees, parseAmount } from '../lib/pricing/net.js';
import { FEES } from '../lib/config/fees.js';

/**
 * Chemin de l'argent : tests avant intégration, pas après (skill money-path).
 *
 * Ces fonctions décident ce qui reste dans la poche après une vente. Une erreur
 * de demi-cent répétée 15 000 fois cesse d'être une erreur d'arrondi.
 */
describe('netAfterFees', () => {
  it('retire la commission et le frais fixe par commande', () => {
    const r = netAfterFees(1000, 0, 'ebay');
    expect(r.feeCents).toBe(Math.round(1000 * FEES.ebay.fvfRate));
    expect(r.perOrderCents).toBe(Math.round(FEES.ebay.perOrderFee * 100));
    expect(r.netCents).toBe(1000 - r.feeCents - r.perOrderCents);
  });

  it('TCGplayer n’a pas de frais fixe par commande', () => {
    expect(netAfterFees(1000, 0, 'tcgplayer').perOrderCents).toBe(0);
  });

  it('déduit l’expédition', () => {
    const sansPort = netAfterFees(2000, 0, 'ebay').netCents;
    const avecPort = netAfterFees(2000, 150, 'ebay').netCents;
    expect(sansPort - avecPort).toBe(150);
  });

it('montre que le plancher à 1,75 $ ne laisse presque rien', () => {
    // Le chiffre que docs/03 §4 veut avoir sous les yeux AVANT de décider.
    // 1,75 $ moins 13,35 % de FVF, moins 0,40 $ par commande, moins 1 $
    // d'enveloppe : il reste 12 cents. Sept pour cent du prix de vente.
    //
    // Ce test ne garde pas un seuil, il garde une VÉRITÉ ÉCONOMIQUE : si un
    // changement de taux ou de plancher rendait ce chiffre confortable, il faut
    // le regarder, pas le laisser passer.
    const r = netAfterFees(175, 100, 'ebay');
    expect(r.netCents).toBe(12);
    expect(r.netCents / r.priceCents).toBeLessThan(0.1);
  });

  it('devient négatif dès que le port dépasse un peu', () => {
    // 1,25 $ de port au lieu de 1,00 $ et la vente coûte de l'argent.
    expect(netAfterFees(175, 125, 'ebay').netCents).toBeLessThan(0);
  });

  it('signale que les taux ne sont pas vérifiés', () => {
    // Tant que ce drapeau est faux, toute UI qui affiche un net doit l'étiqueter
    // comme une estimation. Le jour où il passe à true, ce test devient rouge et
    // force à relire ce qui en dépend.
    expect(netAfterFees(1000, 0, 'ebay').verified).toBe(false);
  });

  it('refuse un montant non entier plutôt que d’arrondir en silence', () => {
    // CLAUDE.md : jamais de float dans un calcul d'argent cumulatif.
    expect(() => netAfterFees(10.5, 0, 'ebay')).toThrow(/cents entiers/);
    expect(() => netAfterFees(1000, 1.5, 'ebay')).toThrow(/cents entiers/);
  });

  it('n’arrondit qu’une fois, à la fin', () => {
    // 333 * 0.1335 = 44.4555. Un arrondi intermédiaire dériverait.
    const r = netAfterFees(333, 0, 'ebay');
    expect(r.feeCents).toBe(Math.round(333 * FEES.ebay.fvfRate));
    expect(r.priceCents - r.feeCents - r.perOrderCents - r.shippingCents).toBe(r.netCents);
  });
});

describe('formatCents', () => {
  it('formate en dollars avec virgule décimale', () => {
    expect(formatCents(1234)).toBe('12,34 $');
    expect(formatCents(5)).toBe('0,05 $');
    expect(formatCents(100)).toBe('1,00 $');
  });

  it('formate un montant négatif sans perdre le signe', () => {
    expect(formatCents(-42)).toBe('-0,42 $');
  });
});

describe('parseAmount', () => {
  it('accepte la virgule comme le point', () => {
    expect(parseAmount('12,34')).toBe(1234);
    expect(parseAmount('12.34')).toBe(1234);
    expect(parseAmount(' 12,5 ')).toBe(1250);
    expect(parseAmount('7')).toBe(700);
  });

  it('rejette une saisie inexploitable plutôt que de rendre NaN', () => {
    // Rendre NaN écrirait un prix nul en base sans que rien ne proteste.
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('12,345')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
  });

  it('fait l’aller-retour avec formatCents', () => {
    for (const cents of [0, 5, 175, 1234, 999999]) {
      expect(parseAmount(formatCents(cents))).toBe(cents);
    }
  });
});
