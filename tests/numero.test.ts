import { describe, expect, it } from 'vitest';
import { candidatDuNumero, lireNumero } from '../lib/review/numero.js';

describe('lireNumero', () => {
  it('sépare numérateur et total', () => {
    expect(lireNumero('2/130')).toEqual({ numero: '2', total: '130' });
  });

  it('retire les zéros de tête des DEUX côtés', () => {
    // L'OCR lit `002` là où le catalogue écrit `2`, et l'inverse arrive aussi.
    expect(lireNumero('002/130')).toEqual({ numero: '2', total: '130' });
    expect(lireNumero('12/0102')).toEqual({ numero: '12', total: '102' });
  });

  it('garde le préfixe alphabétique des sous-séries', () => {
    expect(lireNumero('TG12/TG30')).toEqual({ numero: 'TG12', total: 'TG30' });
    expect(lireNumero('sv049')).toEqual({ numero: 'SV49', total: null });
  });

  it('garde le suffixe des cartes secrètes', () => {
    expect(lireNumero('H12')).toEqual({ numero: 'H12', total: null });
    expect(lireNumero('101a')).toEqual({ numero: '101A', total: null });
  });

  it('absorbe les espaces que produit le scanner autour du slash', () => {
    expect(lireNumero(' 4 / 102 ')).toEqual({ numero: '4', total: '102' });
  });

  it('rejette ce qui n’a pas la forme d’un numéro', () => {
    for (const brut of ['', '   ', null, undefined, 'abc', '1/2/3', '12/', '/102', '—']) {
      expect(lireNumero(brut)).toBeNull();
    }
  });

  it('ne confond pas deux absences de lecture', () => {
    // Deux chaînes vides ne doivent surtout pas s'égaliser : ça ferait
    // « correspondre » toutes les cartes sans numéro entre elles.
    expect(lireNumero('')).toBeNull();
  });
});

const BASE = { number: '2', printedTotal: 102 };
const BASE2 = { number: '2', printedTotal: 130 };
const EXPEDITION = { number: '37', printedTotal: 165 };

describe('candidatDuNumero', () => {
  it('désigne la réimpression exacte, pas la première de la liste', () => {
    // Le cas réel : Base et Base Set 2 portent tous deux le n° 2, seul le total
    // les sépare. C'est LA paire qui coûte du temps humain.
    expect(candidatDuNumero('2/130', [BASE, BASE2, EXPEDITION])).toBe(1);
    expect(candidatDuNumero('2/102', [BASE, BASE2, EXPEDITION])).toBe(0);
  });

  it('s’abstient quand plusieurs candidats correspondent', () => {
    // Sans total lu, `2` désigne deux cartes : un indice ambigu est pire qu'un
    // indice absent.
    expect(candidatDuNumero('2', [BASE, BASE2])).toBeNull();
  });

  it('accepte le numérateur seul quand il est unique', () => {
    expect(candidatDuNumero('37', [BASE, BASE2, EXPEDITION])).toBe(2);
  });

  it('rend null quand rien ne correspond', () => {
    expect(candidatDuNumero('99/165', [BASE, BASE2, EXPEDITION])).toBeNull();
  });

  it('rend null quand rien n’a été lu', () => {
    expect(candidatDuNumero(null, [BASE, BASE2])).toBeNull();
    expect(candidatDuNumero('', [BASE, BASE2])).toBeNull();
  });

  it('ignore les candidats sans numéro imprimé', () => {
    expect(candidatDuNumero('2/102', [{ number: null }, BASE])).toBe(1);
    expect(candidatDuNumero('2/102', [{}, {}])).toBeNull();
  });

  it('compare sur le numérateur quand le catalogue ignore le total', () => {
    // Un total absent en base ne doit pas écarter le candidat : le numérateur
    // reste un indice, il faut juste qu'il soit unique.
    expect(candidatDuNumero('4/102', [{ number: '4', printedTotal: null }])).toBe(0);
  });

  it('rend null sur une liste vide', () => {
    expect(candidatDuNumero('2/102', [])).toBeNull();
  });
});
