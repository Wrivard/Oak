import { describe, expect, it } from 'vitest';
import { filtrer, normaliser, ouvrePalette, score } from '../lib/shell/filtre.js';

describe('normaliser', () => {
  it('retire les accents et la casse', () => {
    expect(normaliser('Santé')).toBe('sante');
    expect(normaliser('  Vérifier ')).toBe('verifier');
    expect(normaliser('Diagnostic')).toBe('diagnostic');
  });
});

describe('score', () => {
  const item = (titre: string, mots?: string) => ({ titre, mots });

  it('classe un début de titre en premier', () => {
    expect(score(item('Prix'), 'pri')).toBe(0);
  });

  it('classe un début de mot avant un milieu de mot', () => {
    const debutDeMot = score(item('Envoyer un lot'), 'lot');
    const milieu = score(item('Pilote'), 'lot');
    expect(debutDeMot).not.toBeNull();
    expect(milieu).not.toBeNull();
    expect(debutDeMot as number).toBeLessThan(milieu as number);
  });

  it('trouve par mot-clé, mais moins bien', () => {
    const parTitre = score(item('Inventaire'), 'inv');
    const parMot = score(item('Prix', 'inventaire pricing'), 'inv');
    expect((parTitre as number)).toBeLessThan(parMot as number);
  });

  it('ignore les accents dans les deux sens', () => {
    expect(score(item('Santé'), 'sante')).toBe(0);
    expect(score(item('Sante'), 'santé')).toBe(0);
  });

  it('rend null quand rien ne correspond', () => {
    expect(score(item('Prix'), 'charizard')).toBeNull();
  });

  it('accepte tout sur une requête vide', () => {
    expect(score(item('Prix'), '')).toBe(0);
    expect(score(item('Prix'), '   ')).toBe(0);
  });
});

describe('filtrer', () => {
  const ITEMS = [
    { titre: 'Envoyer' },
    { titre: 'Lots' },
    { titre: 'Review' },
    { titre: 'Vérifier' },
    { titre: 'Inventaire' },
    { titre: 'Prix', mots: 'pricing règles' },
    { titre: 'Diagnostic' },
    { titre: 'Santé', mots: 'dashboard tableau de bord' },
  ];

  it('garde l’ordre d’origine à score égal', () => {
    expect(filtrer(ITEMS, '').map((i) => i.titre)).toEqual(ITEMS.map((i) => i.titre));
  });

  it('ne classe PAS « Diagnostic » devant « Prix » pour `pri`', () => {
    // C'est le piège d'une correspondance floue : p-r-i se trouvent dispersés
    // dans « Diagnostic », et on appuie sur Entrée sur la mauvaise entrée.
    expect(filtrer(ITEMS, 'pri')[0]?.titre).toBe('Prix');
  });

  it('trouve un écran par son nom technique', () => {
    expect(filtrer(ITEMS, 'dashboard')[0]?.titre).toBe('Santé');
  });

  it('rend une liste vide plutôt que tout', () => {
    expect(filtrer(ITEMS, 'zzz')).toEqual([]);
  });
});

describe('ouvrePalette', () => {
  const appui = (o: Partial<Parameters<typeof ouvrePalette>[0]>) =>
    ouvrePalette({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, ...o });

  it('s’ouvre sur Ctrl+K et sur Cmd+K', () => {
    expect(appui({ ctrlKey: true })).toBe(true);
    expect(appui({ metaKey: true })).toBe(true);
  });

  it('accepte la majuscule', () => {
    // Verrouillage des majuscules, ou Maj tenue par réflexe.
    expect(appui({ key: 'K', ctrlKey: true })).toBe(true);
  });

  it('ne s’ouvre pas sur K seul', () => {
    // Sinon taper « Kabuto » dans un champ de recherche ouvrirait la palette.
    expect(appui({})).toBe(false);
  });

  it('laisse Ctrl+Alt+K au système', () => {
    expect(appui({ ctrlKey: true, altKey: true })).toBe(false);
  });

  it('ignore les autres touches avec Ctrl', () => {
    for (const key of ['a', 's', 'p', 'Enter', 'ArrowDown']) {
      expect(appui({ key, ctrlKey: true })).toBe(false);
    }
  });
});
