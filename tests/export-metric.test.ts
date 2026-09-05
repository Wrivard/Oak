import { describe, expect, it } from 'vitest';
import { computeExport } from '../lib/metrics/export.js';

/**
 * Le dernier export TCGplayer.
 *
 * L'export tourne par cron et écrit un CSV. Quand il écarte tout — aujourd'hui
 * parce que `tcg_sku_id` est vide sur tout l'inventaire — il produit un fichier
 * VIDE, note le détail dans `channel_events`, et rien à l'écran ne le disait. On
 * pouvait donc téléverser un fichier sans lignes des jours durant en croyant
 * pousser son stock.
 *
 * L'écart n'est pas une erreur en soi : une carte sans `tcg_sku_id` ne peut pas
 * être exportée, et l'inventer serait pire. Ce qui manquait, c'était de le voir.
 */
describe('computeExport', () => {
  it('ALARME quand le fichier est vide alors qu’il y avait du stock', () => {
    // Le cas mesuré le 5 septembre : onze SKUs prixés, zéro ligne exportée.
    const m = computeExport({
      at: '2026-09-05 15:40',
      lignes: 0,
      ecartees: 11,
      detail: { sans_tcg_sku_id: 11 },
    });
    expect(m.health).toBe('alarm');
    expect(m.detail).toMatch(/VIDE/);
    expect(m.detail).toContain('sans tcg sku id 11');
  });

  it('avertit quand une partie seulement est écartée', () => {
    const m = computeExport({
      at: '2026-09-05 15:40',
      lignes: 900,
      ecartees: 40,
      detail: { sans_tcg_sku_id: 40 },
    });
    expect(m.health).toBe('warn');
    expect(m.value).toBe('900');
  });

  it('vert quand tout passe', () => {
    const m = computeExport({
      at: '2026-09-05 15:40',
      lignes: 940,
      ecartees: 0,
      detail: {},
    });
    expect(m.health).toBe('ok');
    expect(m.detail).toMatch(/tout l’inventaire|tout l'inventaire/);
  });

  it('un inventaire vide n’est pas une alarme', () => {
    // Zéro ligne parce qu'il n'y a rien à exporter n'est pas la même chose que
    // zéro ligne parce que tout a été écarté.
    const m = computeExport({ at: '2026-09-05 15:40', lignes: 0, ecartees: 0, detail: {} });
    expect(m.health).toBe('ok');
    expect(m.detail).toMatch(/inventaire vide/);
  });

  it('aucun export encore généré ne dit pas que tout va mal', () => {
    expect(computeExport(null).health).toBe('ok');
    expect(computeExport({ at: null, lignes: 0, ecartees: 0, detail: {} }).health).toBe('ok');
  });

  it('classe les raisons par importance', () => {
    const m = computeExport({
      at: '2026-09-05 15:40',
      lignes: 10,
      ecartees: 30,
      detail: { sans_prix: 5, sans_tcg_sku_id: 25, autre: 0 },
    });
    // La raison majoritaire d'abord : c'est elle qu'il faut corriger.
    expect(m.detail.indexOf('sans tcg sku id')).toBeLessThan(m.detail.indexOf('sans prix'));
    // Et une raison à zéro n'encombre pas la ligne.
    expect(m.detail).not.toContain('autre');
  });

  it('reste lisible quand le détail manque', () => {
    const m = computeExport({ at: '2026-09-05 15:40', lignes: 0, ecartees: 7, detail: {} });
    expect(m.health).toBe('alarm');
    expect(m.detail).toMatch(/raison non détaillée/);
  });
});
