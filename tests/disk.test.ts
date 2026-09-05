import { describe, expect, it } from 'vitest';
import { computeDisk, QUOTA_DEFAUT_MO } from '../lib/metrics/disk.js';

/**
 * La taille de la base contre le quota du plan.
 *
 * Ce n'est pas une métrique de confort. Au-delà du quota, Supabase passe la base
 * en LECTURE SEULE : les uploads échouent, l'inventaire ne bouge plus, le worker
 * meurt sur `cannot execute INSERT in a read-only transaction`. Le pipeline
 * s'arrête net — pas un ralentissement, un mur.
 *
 * C'est arrivé le 5 septembre 2026, en écrivant 200 000 empreintes de mesure :
 * la base est passée à 850 Mo et le projet est devenu lecture seule. Rien dans
 * l'application ne l'avait vu venir, et rien ne l'aurait vu venir le jour où ça
 * arriverait pour de vrai.
 */
const MO = 1024 * 1024;

describe('computeDisk', () => {
  it('vert loin du quota', () => {
    const d = computeDisk(138 * MO);
    expect(d.health).toBe('ok');
    expect(d.value).toBe('28 %');
    expect(d.detail).toContain('362 Mo libres');
  });

  it('AVERTIT À 80 % — il reste des semaines pour agir', () => {
    const d = computeDisk(0.82 * QUOTA_DEFAUT_MO * MO);
    expect(d.health).toBe('warn');
    expect(d.detail).toMatch(/lecture seule/);
  });

  it('ALARME À 95 % — il reste des jours', () => {
    const d = computeDisk(0.96 * QUOTA_DEFAUT_MO * MO);
    expect(d.health).toBe('alarm');
    expect(d.detail).toMatch(/LECTURE SEULE/);
  });

  it('dit ce qu’on perd, pas seulement un pourcentage', () => {
    // Un seuil dont on ignore la conséquence finit par être ignoré.
    const d = computeDisk(0.99 * QUOTA_DEFAUT_MO * MO);
    expect(d.detail).toMatch(/plus aucun scan/);
  });

  it('ne descend pas sous zéro quand le quota est dépassé', () => {
    // Le cas réel du 5 septembre : 850 Mo pour un quota de 500.
    const d = computeDisk(850 * MO);
    expect(d.health).toBe('alarm');
    expect(d.detail).toContain('0 Mo libres');
    expect(d.value).toBe('170 %');
  });

  it('suit le quota qu’on lui donne', () => {
    // Passer au plan Pro déplace le mur, il ne le supprime pas.
    const d = computeDisk(600 * MO, 8192);
    expect(d.health).toBe('ok');
    expect(d.detail).toContain('sur 8192');
  });

  it('une base vide n’est pas une alarme', () => {
    expect(computeDisk(0).health).toBe('ok');
  });
});
