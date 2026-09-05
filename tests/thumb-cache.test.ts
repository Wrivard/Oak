import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneThumbs } from '../lib/images/thumb-cache.js';
import { EXTENSIONS_IMAGE, extensionSure } from '../lib/images/extensions.js';

/**
 * Purge des vignettes.
 *
 * Rien ne les effaçait : une vignette par scan, ~60 ko, à 25-50 000 cartes par
 * mois. Soit 1,5 à 3 Go par mois indéfiniment sur le disque local — des dizaines
 * de gigaoctets de vignettes de cartes vendues depuis longtemps.
 */
let dir: string;

async function vignette(nom: string, ageJours: number): Promise<void> {
  const chemin = join(dir, nom);
  await writeFile(chemin, 'x');
  const quand = new Date(Date.now() - ageJours * 24 * 3600 * 1000);
  await utimes(chemin, quand, quand);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pokelister-thumb-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('pruneThumbs', () => {
  it('efface les vieilles, garde les récentes', async () => {
    await vignette('vieille.jpg', 45);
    await vignette('recente.jpg', 3);

    expect(await pruneThumbs(30, dir)).toBe(1);
    expect(await readdir(dir)).toEqual(['recente.jpg']);
  });

  it('ne touche QUE les .jpg', async () => {
    // Le répertoire est à nous, mais effacer ce qu'on n'a pas écrit est le
    // genre de raccourci qu'on regrette.
    await vignette('vieille.jpg', 45);
    await vignette('autre.txt', 45);

    await pruneThumbs(30, dir);
    expect(await readdir(dir)).toEqual(['autre.txt']);
  });

  it('respecte le délai qu’on lui donne', async () => {
    await vignette('a.jpg', 10);
    expect(await pruneThumbs(30, dir)).toBe(0);
    expect(await pruneThumbs(5, dir)).toBe(1);
  });

  it('un répertoire absent n’est pas une erreur', async () => {
    // C'est le cas au premier démarrage, avant qu'une seule vignette existe.
    expect(await pruneThumbs(30, join(dir, 'nexistepas'))).toBe(0);
  });

  it('un répertoire vide ne fait rien', async () => {
    expect(await pruneThumbs(30, dir)).toBe(0);
  });
});

describe('extensions d’image', () => {
  it('reconnaît ce qu’un scanner produit', () => {
    for (const n of ['a.jpg', 'a.JPEG', 'a.png', 'a.webp', 'a.tif', 'a.TIFF', 'a.bmp']) {
      expect(EXTENSIONS_IMAGE.test(n)).toBe(true);
    }
  });

  it('refuse ce qui n’en est pas', () => {
    for (const n of ['a.pdf', 'a.txt', 'Thumbs.db', 'a.jpg.exe']) {
      expect(EXTENSIONS_IMAGE.test(n)).toBe(false);
    }
  });

  it('GARDE L’EXTENSION D’ORIGINE — un .tif reste un .tif sur disque', () => {
    // L'appariement filtre le répertoire par extension : renommer un .tif en
    // .jpg n'a aucune conséquence (tout lit le contenu), mais garder la vraie
    // extension rend le répertoire lisible quand on va y regarder.
    expect(extensionSure('image0001.tif')).toBe('.tif');
    expect(extensionSure('IMAGE0002.TIFF')).toBe('.tiff');
    expect(extensionSure('a.PNG')).toBe('.png');
  });

  it('retombe sur .jpg pour l’inconnu, sans jamais garder le nom d’origine', () => {
    // Le nom vient de l'utilisateur : le réutiliser tel quel permettrait de
    // sortir du répertoire.
    expect(extensionSure('sans-extension')).toBe('.jpg');
    expect(extensionSure('../../evil')).toBe('.jpg');
    expect(extensionSure('a.heic')).toBe('.jpg');
  });
});
