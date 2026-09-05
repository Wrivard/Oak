import { describe, expect, it } from 'vitest';
import { estImage, filesFromDrop, type DropSource, type FsEntry } from '../lib/upload/drop.js';

/**
 * Glisser le DOSSIER du scanner.
 *
 * C'est le premier geste de la journée, et c'était une panne silencieuse :
 * `dataTransfer.files` ne contient rien quand on glisse un dossier. L'écran
 * affichait « 0 photo » et on ne pouvait pas deviner pourquoi. Une carte
 * scannée sans ligne d'inventaire est l'échec le plus cher du système, donc
 * ce chemin est testé plutôt que relu.
 */

function fichier(name: string, type = 'image/jpeg'): File {
  // On ne teste pas le contenu, seulement le nom et le transport.
  return new File([new Uint8Array([1])], name, { type });
}

function entreeFichier(f: File): FsEntry {
  return {
    isFile: true,
    isDirectory: false,
    file: (cb) => cb(f),
    createReader: () => {
      throw new Error('un fichier n’a pas de reader');
    },
  };
}

/**
 * Un dossier qui rend ses entrées **par paquets de 100**, comme le vrai
 * `readEntries`. C'est le piège central : l'API ne rend pas tout d'un coup et
 * ne le signale pas — il faut rappeler jusqu'au paquet vide.
 */
function entreeDossier(enfants: FsEntry[], taillePaquet = 100): FsEntry {
  let i = 0;
  return {
    isFile: false,
    isDirectory: true,
    file: () => {
      throw new Error('un dossier n’a pas de file()');
    },
    createReader: () => ({
      readEntries: (cb) => {
        const lot = enfants.slice(i, i + taillePaquet);
        i += lot.length;
        cb(lot);
      },
    }),
  };
}

function drop(entries: FsEntry[], files: File[] = []): DropSource {
  return {
    items: entries.map((e) => ({ webkitGetAsEntry: () => e })),
    files,
  };
}

describe('filesFromDrop', () => {
  it('descend dans un dossier glissé — le cas qui rendait 0 photo', async () => {
    const dossier = entreeDossier(
      ['image0001.jpg', 'image0002.jpg', 'image0003.jpg'].map((n) =>
        entreeFichier(fichier(n)),
      ),
    );
    const out = await filesFromDrop(drop([dossier]));
    expect(out.map((f) => f.name)).toEqual([
      'image0001.jpg',
      'image0002.jpg',
      'image0003.jpg',
    ]);
  });

  it('LIT AU-DELÀ DE 100 — readEntries tronque sans le dire', async () => {
    // Le vrai piège. Un lot de scanner fait des centaines de pages ; s'arrêter
    // au premier paquet en garderait 100 et l'appariement recto/verso
    // décalerait tout ce qui suit, sans aucune erreur visible.
    const noms = Array.from({ length: 850 }, (_, i) =>
      `image${String(i + 1).padStart(4, '0')}.jpg`,
    );
    const out = await filesFromDrop(
      drop([entreeDossier(noms.map((n) => entreeFichier(fichier(n))))]),
    );
    expect(out).toHaveLength(850);
    expect(out[0]?.name).toBe('image0001.jpg');
    expect(out[849]?.name).toBe('image0850.jpg');
  });

  it('descend dans les sous-dossiers', async () => {
    const sous = entreeDossier([entreeFichier(fichier('b.jpg'))]);
    const racine = entreeDossier([entreeFichier(fichier('a.jpg')), sous]);
    const out = await filesFromDrop(drop([racine]));
    expect(out.map((f) => f.name).sort()).toEqual(['a.jpg', 'b.jpg']);
  });

  it('accepte plusieurs dossiers glissés ensemble', async () => {
    const d1 = entreeDossier([entreeFichier(fichier('a.jpg'))]);
    const d2 = entreeDossier([entreeFichier(fichier('b.jpg'))]);
    const out = await filesFromDrop(drop([d1, d2]));
    expect(out).toHaveLength(2);
  });

  it('retombe sur dataTransfer.files quand l’API d’entrées manque', async () => {
    const out = await filesFromDrop({ items: [{}], files: [fichier('x.jpg')] });
    expect(out.map((f) => f.name)).toEqual(['x.jpg']);
  });

  it('ne perd pas le lot si un fichier refuse de se lire', async () => {
    const cassé: FsEntry = {
      isFile: true,
      isDirectory: false,
      file: (_cb, err) => err(new Error('permission refusée')),
      createReader: () => {
        throw new Error('n/a');
      },
    };
    const out = await filesFromDrop(
      drop([entreeDossier([cassé, entreeFichier(fichier('ok.jpg'))])]),
    );
    // Un fichier illisible saute ; les autres passent. Le compteur affiché
    // permettra de voir qu'il en manque un.
    expect(out.map((f) => f.name)).toEqual(['ok.jpg']);
  });
});

describe('estImage', () => {
  it('accepte un .tif au type MIME vide — ce que sort un scanner', () => {
    // Chrome laisse `type` vide sur certaines extensions. S'en tenir au MIME
    // jetait des pages réellement scannées.
    expect(estImage({ name: 'image0001.tif', type: '' })).toBe(true);
    expect(estImage({ name: 'IMAGE0002.TIFF', type: '' })).toBe(true);
    expect(estImage({ name: 'a.jpeg', type: '' })).toBe(true);
  });

  it('accepte par type MIME quand l’extension est absente', () => {
    expect(estImage({ name: 'sans-extension', type: 'image/png' })).toBe(true);
  });

  it('refuse ce qui n’est pas une image', () => {
    expect(estImage({ name: 'index.pdf', type: 'application/pdf' })).toBe(false);
    expect(estImage({ name: 'Thumbs.db', type: '' })).toBe(false);
    expect(estImage({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });
});
