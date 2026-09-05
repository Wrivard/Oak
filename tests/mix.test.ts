import { describe, expect, it } from 'vitest';
import { computeMix, MANUAL_RATE_ALARM } from '../lib/metrics/mix.js';

/**
 * La métrique économique principale du projet.
 *
 * Elle comptait les scans encore en review comme du manuel. Conséquence : la
 * métrique passait en ALARME dès le premier lot envoyé et y restait jusqu'à ce
 * que la review soit vidée. À 1 700 cartes par jour, elle serait allumée en
 * permanence — et une alarme toujours allumée n'est plus une alarme : on
 * apprend à ne plus la regarder, y compris le jour où elle a raison.
 *
 * Le calcul vit hors du SQL précisément parce que c'est LE calcul qui était faux.
 */
describe('computeMix', () => {
  it('NE COMPTE PAS L’ARRIÉRÉ COMME DU MANUEL', () => {
    // Le cas exact du 5 septembre : un lot vient d'entrer, 11 cartes résolues
    // par le catalogue, 37 en attente. L'écran affichait « 77 % manuel » et
    // « Alarme ».
    const mix = computeMix({ own: 0, catalog: 11, manual: 0, attente: 37 });
    expect(mix.rate).toBe(0);
    expect(mix.health).toBe('ok');
    expect(mix.value).toBe('0 % manuel');
  });

  it('mentionne quand même l’arriéré, sans le compter', () => {
    // L'information n'est pas perdue : elle est juste au bon endroit.
    const mix = computeMix({ own: 5, catalog: 5, manual: 0, attente: 37 });
    expect(mix.detail).toContain('37 en attente');
    expect(mix.decides).toBe(10);
  });

  it('ne l’affiche pas quand il n’y en a pas', () => {
    const mix = computeMix({ own: 5, catalog: 5, manual: 0, attente: 0 });
    expect(mix.detail).not.toContain('en attente');
  });

  it('alarme au-dessus du seuil sur les DÉCIDÉS', () => {
    // 20 % de manuel sur ce qui a été décidé : le coût marginal ne descend pas.
    const mix = computeMix({ own: 40, catalog: 40, manual: 20, attente: 0 });
    expect(mix.rate).toBeCloseTo(0.2);
    expect(mix.rate).toBeGreaterThan(MANUAL_RATE_ALARM);
    expect(mix.health).toBe('alarm');
  });

  it('avertit dans la zone intermédiaire', () => {
    const mix = computeMix({ own: 40, catalog: 48, manual: 12, attente: 0 });
    expect(mix.health).toBe('warn');
  });

  it('reste vert quand le niveau 1 fait son travail', () => {
    // La boucle d'apprentissage : la part own_history monte, le manuel tombe.
    const mix = computeMix({ own: 900, catalog: 80, manual: 20, attente: 300 });
    expect(mix.health).toBe('ok');
    expect(mix.value).toBe('2 % manuel');
  });

  it('un arriéré ÉNORME ne déclenche toujours pas cette alarme-ci', () => {
    // Il en a une autre, « Cartes en review », avec son seuil sur la capacité
    // quotidienne. Mélanger les deux détruisait le signal des deux.
    const mix = computeMix({ own: 100, catalog: 0, manual: 0, attente: 50_000 });
    expect(mix.health).toBe('ok');
  });

  it('ne calcule pas de taux sur zéro décision', () => {
    const vide = computeMix({ own: 0, catalog: 0, manual: 0, attente: 0 });
    expect(vide.rate).toBeNull();
    expect(vide.value).toBe('—');
    expect(vide.detail).toMatch(/aucun scan/);

    const quAttente = computeMix({ own: 0, catalog: 0, manual: 0, attente: 40 });
    expect(quAttente.rate).toBeNull();
    expect(quAttente.health).toBe('ok');
    expect(quAttente.detail).toMatch(/40 en attente/);
  });

  it('100 % manuel est une alarme, pas une division par zéro', () => {
    const mix = computeMix({ own: 0, catalog: 0, manual: 7, attente: 0 });
    expect(mix.rate).toBe(1);
    expect(mix.health).toBe('alarm');
  });
});
