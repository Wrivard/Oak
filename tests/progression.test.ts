import { describe, expect, it } from 'vitest';
import { progression } from '../lib/upload/progression.js';

describe('progression', () => {
  it('calcule le pourcentage et le reste', () => {
    const p = progression(500, 2000, 60_000);
    expect(p.pct).toBe(25);
    expect(p.restantes).toBe(1500);
  });

  it('se tait tant que la mesure ne vaut rien', () => {
    // Le premier paquet ne fait pas un rythme : annoncer « 4 heures » parce
    // qu'il a mis deux secondes est pire que de ne rien annoncer.
    expect(progression(10, 2000, 800).eta).toBeNull();
    expect(progression(0, 2000, 30_000).eta).toBeNull();
  });

  it('annonce une durée une fois le rythme mesuré', () => {
    // 500 pages en 60 s = 8,33/s ; 1500 restantes = 180 s = 3 min.
    expect(progression(500, 2000, 60_000).eta).toBe('~3 min');
  });

  it('ne dit rien quand tout est passé', () => {
    const p = progression(2000, 2000, 120_000);
    expect(p.pct).toBe(100);
    expect(p.restantes).toBe(0);
    expect(p.eta).toBeNull();
  });

  it('arrondit les secondes par tranches de cinq', () => {
    // 100 pages en 10 s = 10/s ; 220 restantes = 22 s -> 25 s.
    expect(progression(100, 320, 10_000).eta).toBe('~25 s');
  });

  it('dit « quelques secondes » plutôt qu’un chiffre qui bouge', () => {
    // Sous dix secondes, le chiffre change plus vite qu'on ne le lit.
    expect(progression(300, 320, 30_000).eta).toBe('quelques secondes');
  });

  it('passe aux heures sans afficher les secondes', () => {
    // 10 pages en 60 s = 1/6 par s ; 3590 restantes ≈ 21 540 s ≈ 359 min.
    const p = progression(10, 3600, 60_000);
    expect(p.eta).toBe('~5 h 59 min');
  });

  it('ne dépasse jamais cent pour cent', () => {
    // Le serveur renvoie le total du LOT, qui peut dépasser ce qu'on envoie
    // quand le lot contenait déjà des pages.
    const p = progression(4000, 2000, 60_000);
    expect(p.pct).toBe(100);
    expect(p.restantes).toBe(0);
  });

  it('supporte un total absent ou absurde', () => {
    for (const total of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = progression(10, total, 60_000);
      expect(p.pct).toBe(0);
      expect(p.eta).toBeNull();
    }
  });

  it('ne divise pas par zéro sur un temps écoulé nul', () => {
    expect(progression(10, 2000, 0).eta).toBeNull();
  });
});
