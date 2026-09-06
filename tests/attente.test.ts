import { describe, expect, it } from 'vitest';
import { ATTENTE_MIN_MS, prochaineAttente } from '../worker/queue/attente.js';

describe('recul des voies inactives', () => {
  it('part de la valeur minimale et croît', () => {
    const a = prochaineAttente(ATTENTE_MIN_MS, 2000);
    expect(a).toBeGreaterThan(ATTENTE_MIN_MS);
  });

  it('n’explose jamais au-delà du plafond', () => {
    let a = ATTENTE_MIN_MS;
    for (let i = 0; i < 50; i += 1) a = prochaineAttente(a, 2000);
    expect(a).toBe(2000);
  });

  it('atteint son plafond après quelques secondes d’inactivité', () => {
    // Ce qui compte n'est pas le nombre de pas mais le TEMPS écoulé. MESURÉ :
    // 500, 800, 1280, puis le plafond — 2,6 s d'inactivité avant qu'une voie
    // ne passe à un sondage toutes les deux secondes.
    //
    // La borne haute est le vrai garde-fou : si quelqu'un ralentit la
    // croissance, une voie mettrait une minute à se calmer et le gain
    // disparaîtrait. La borne basse empêche l'inverse, un recul si brutal que
    // la reprise après une pause coûterait le plafond entier.
    let a = ATTENTE_MIN_MS;
    let cumul = 0;
    let pas = 0;
    while (a < 2000 && pas < 100) {
      cumul += a;
      a = prochaineAttente(a, 2000);
      pas += 1;
    }
    expect(cumul).toBe(2580);
    expect(pas).toBe(3);
  });

  it('respecte un plafond plus haut pour le travail de fond', () => {
    let a = ATTENTE_MIN_MS;
    for (let i = 0; i < 50; i += 1) a = prochaineAttente(a, 10_000);
    expect(a).toBe(10_000);
  });

  it('ne descend jamais sous le minimum, même si on lui ment', () => {
    expect(prochaineAttente(0, 2000)).toBeGreaterThanOrEqual(ATTENTE_MIN_MS);
    expect(prochaineAttente(-5, 2000)).toBeGreaterThanOrEqual(ATTENTE_MIN_MS);
    // Un plafond absurde ne doit pas produire une attente plus courte que le
    // minimum : ça ferait tourner la voie à vide en boucle serrée.
    expect(prochaineAttente(ATTENTE_MIN_MS, 10)).toBe(ATTENTE_MIN_MS);
  });

  it('rend des millisecondes entières', () => {
    let a = ATTENTE_MIN_MS;
    for (let i = 0; i < 10; i += 1) {
      a = prochaineAttente(a, 10_000);
      expect(Number.isInteger(a)).toBe(true);
    }
  });
});
