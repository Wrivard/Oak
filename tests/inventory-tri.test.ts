import { describe, expect, it } from 'vitest';
import { ORDER } from '../app/inventory/queries.js';
import { SENS, SENS_PAR_DEFAUT, TRIS } from '../app/inventory/tri.js';

/**
 * Le tri de l'inventaire s'interpole dans un `order by`.
 *
 * Une clé absente de la table ne se voit pas à la compilation quand elle vient
 * de l'URL : elle donne `order by undefined` et une page en 500. La table doit
 * couvrir exactement le vocabulaire, dans les deux sens.
 */
describe('table de tri de l’inventaire', () => {
  it('couvre chaque colonne dans les deux sens', () => {
    for (const tri of TRIS) {
      for (const sens of SENS) {
        expect(typeof ORDER[tri]?.[sens]).toBe('string');
        expect(ORDER[tri]?.[sens]?.length).toBeGreaterThan(0);
      }
    }
  });

  it('n’a pas de colonne en trop', () => {
    expect(Object.keys(ORDER).sort()).toEqual([...TRIS].sort());
  });

  it('donne un sens par défaut à chaque colonne', () => {
    for (const tri of TRIS) {
      expect(SENS).toContain(SENS_PAR_DEFAUT[tri]);
    }
  });

  it('départage toujours par SKU', () => {
    // Sans second critère, deux lignes de même valeur changent de place d'une
    // page à l'autre : la pagination en oublie ou en répète.
    for (const tri of TRIS) {
      for (const sens of SENS) {
        expect(ORDER[tri]?.[sens]).toContain('i.sku');
      }
    }
  });

  it('garde les valeurs manquantes en bas, dans les deux sens', () => {
    // Une carte sans valeur estimée ne doit jamais ouvrir une liste qu'on trie
    // justement par valeur.
    expect(ORDER.value.asc).toContain('nulls last');
    expect(ORDER.value.desc).toContain('nulls last');
  });
});
