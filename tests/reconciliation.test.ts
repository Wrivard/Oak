import { describe, expect, it } from 'vitest';
import { computeReconciliation } from '../lib/metrics/reconciliation.js';

/**
 * L'absence d'écart et l'absence de contrôle ne sont pas la même chose.
 *
 * La métrique affichait « toutes les sessions balancent » alors qu'aucun lot
 * ouvert n'avait de comptage attendu — c'est-à-dire pendant que le contrôle
 * était purement inactif. Une fausse assurance sur exactement le point qu'on ne
 * peut pas rattraper plus tard : une carte physiquement scannée sans ligne
 * d'inventaire ne se retrouve jamais.
 *
 * `expected_count` reste nul tant qu'on ne saisit pas à la main le nombre de
 * cartes mises dans le scanner. Le cas « non vérifiable » est donc le cas
 * NORMAL, pas un cas limite.
 */
describe('computeReconciliation', () => {
  it('NE DIT PAS « ça balance » quand rien n’est vérifiable', () => {
    // Le cas exact du 5 septembre : deux lots ouverts, aucun comptage saisi.
    const r = computeReconciliation([
      { name: 'repetition', expected: null, scanned: 40 },
      { name: 'edge-cases', expected: null, scanned: 10 },
    ]);
    expect(r.health).toBe('warn');
    expect(r.detail).toMatch(/contrôle inactif/);
    expect(r.detail).toContain('repetition');
    expect(r.value).not.toBe('0');
  });

  it('alarme sur un écart réel', () => {
    // 12 feuilles dans l'ADF, 10 scans : deux cartes existent sans inventaire.
    const r = computeReconciliation([{ name: 'lundi', expected: 12, scanned: 10 }]);
    expect(r.health).toBe('alarm');
    expect(r.detail).toContain('10/12');
  });

  it('L’ÉCART PRIME sur le contrôle inactif', () => {
    // Un lot en écart et un lot non vérifiable : c'est l'écart qu'il faut voir,
    // c'est lui la carte qu'on est en train de perdre.
    const r = computeReconciliation([
      { name: 'sans-compte', expected: null, scanned: 300 },
      { name: 'lundi', expected: 12, scanned: 10 },
    ]);
    expect(r.health).toBe('alarm');
    expect(r.detail).toContain('lundi');
  });

  it('vert quand tout est compté et balance', () => {
    const r = computeReconciliation([
      { name: 'lundi', expected: 200, scanned: 200 },
      { name: 'mardi', expected: 150, scanned: 150 },
    ]);
    expect(r.health).toBe('ok');
    expect(r.value).toBe('0');
    expect(r.detail).toMatch(/comptage vérifié/);
  });

  it('signale le mélange : certains vérifiés, d’autres non', () => {
    const r = computeReconciliation([
      { name: 'lundi', expected: 200, scanned: 200 },
      { name: 'mardi', expected: null, scanned: 40 },
    ]);
    expect(r.health).toBe('warn');
    expect(r.detail).toMatch(/non vérifiable/);
  });

  it('aucun lot ouvert n’est pas une anomalie', () => {
    const r = computeReconciliation([]);
    expect(r.health).toBe('ok');
    expect(r.detail).toBe('aucun lot ouvert');
  });

  it('un excédent est un écart lui aussi', () => {
    // Plus de scans que de feuilles annoncées : une carte a peut-être été
    // scannée deux fois, et l'inventaire la compte deux fois.
    const r = computeReconciliation([{ name: 'lundi', expected: 200, scanned: 205 }]);
    expect(r.health).toBe('alarm');
    expect(r.detail).toContain('205/200');
  });

  it('un lot vide avec un comptage à zéro balance', () => {
    const r = computeReconciliation([{ name: 'vide', expected: 0, scanned: 0 }]);
    expect(r.health).toBe('ok');
  });
});
