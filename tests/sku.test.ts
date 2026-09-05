import { describe, expect, it } from 'vitest';
import { buildSku, parseSku, VARIANTS, CONDITIONS } from '../lib/sku.js';

/**
 * buildSku est le seul constructeur de SKU du codebase (invariant 8).
 * Le piège : card_id contient déjà des tirets, donc le parsing se fait par la
 * droite. Si ce test casse, des SKU sont mal découpés quelque part.
 */
describe('buildSku / parseSku', () => {
  it('construit le format {card_id}-{variant}-{condition}-{lang}', () => {
    expect(
      buildSku({ card_id: 'base1-4', variant: 'holofoil', condition: 'NM', language: 'en' }),
    ).toBe('base1-4-holofoil-NM-en');
  });

  it('normalise la langue en minuscules', () => {
    expect(
      buildSku({ card_id: 'base1-4', variant: 'normal', condition: 'LP', language: 'EN' }),
    ).toBe('base1-4-normal-LP-en');
  });

  it('fait l’aller-retour sur un card_id qui contient des tirets', () => {
    const parts = {
      card_id: 'swshp-SWSH284',
      variant: 'promo',
      condition: 'NM',
      language: 'en',
    } as const;
    expect(parseSku(buildSku(parts))).toEqual(parts);
  });

  it('refuse un SKU malformé', () => {
    expect(() => parseSku('base1-4')).toThrow(/malformé/);
  });

  it('refuse un card_id vide', () => {
    expect(() =>
      buildSku({ card_id: '', variant: 'normal', condition: 'NM', language: 'en' }),
    ).toThrow(/card_id/);
  });
});

describe('le SKU est une clé : ce qui le casserait est refusé', () => {
  /**
   * Le parsing se fait par la DROITE — les trois derniers segments sont
   * language, condition et variant. Un séparateur dans l'un des trois décale
   * tout, et le SKU cesse d'être une clé. Le card_id, lui, a le droit d'en
   * contenir : c'est ce que le parsing par la droite absorbe.
   */
  it('REFUSE une langue qui contient un tiret', () => {
    // `pt-br` ferait lire « br » en langue, « pt » en condition et « NM » en
    // variant. Le SKU serait accepté, stocké, et faux.
    expect(() =>
      buildSku({ card_id: 'base1-4', variant: 'normal', condition: 'NM', language: 'pt-br' }),
    ).toThrow(/langue/);
  });

  it('refuse un variant ou une condition inconnus', () => {
    // Un cast rend un CardVariant qui n'en est pas un, et l'erreur ressort plus
    // loin sous une forme qui ne dit rien — un prix cherché pour un printing
    // qui n'existe pas, par exemple.
    expect(() =>
      buildSku({
        card_id: 'base1-4',
        variant: 'holo' as never,
        condition: 'NM',
        language: 'en',
      }),
    ).toThrow(/variant/);
    expect(() =>
      buildSku({
        card_id: 'base1-4',
        variant: 'normal',
        condition: 'MINT' as never,
        language: 'en',
      }),
    ).toThrow(/condition/);
  });

  it('parseSku VALIDE au lieu de caster', () => {
    expect(() => parseSku('base1-4-holo-NM-en')).toThrow(/variant/);
    expect(() => parseSku('base1-4-normal-MINT-en')).toThrow(/condition/);
    expect(() => parseSku('-normal-NM-en')).toThrow(/card_id/);
  });

  it('accepte tous les variants et conditions réels', () => {
    for (const v of VARIANTS) {
      for (const c of CONDITIONS) {
        const sku = buildSku({ card_id: 'swshp-SWSH284', variant: v, condition: c, language: 'en' });
        expect(parseSku(sku)).toEqual({
          card_id: 'swshp-SWSH284',
          variant: v,
          condition: c,
          language: 'en',
        });
      }
    }
  });
});
