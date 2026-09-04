import { describe, expect, it } from 'vitest';
import { buildSku, parseSku } from '../lib/sku.js';

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
