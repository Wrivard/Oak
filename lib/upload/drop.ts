/**
 * Lire ce qu'on vient de glisser dans la fenêtre.
 *
 * Un scanner ne produit pas des fichiers, il produit un DOSSIER. Le geste
 * naturel est donc de glisser le dossier — et `dataTransfer.files` est alors
 * vide, ou ne contient que le dossier lui-même. Sans ce qui suit, le lot entier
 * disparaît en silence au premier geste de la journée : le pire mode d'échec du
 * système, des cartes physiquement scannées sans aucune ligne d'inventaire.
 *
 * `webkitGetAsEntry` est la seule façon de descendre dans l'arborescence. Le nom
 * est préfixé `webkit` mais l'API est implémentée partout depuis longtemps ; on
 * retombe sur `dataTransfer.files` si elle manque.
 *
 * Ce code vit hors du composant pour être testable : la panne qu'il évite ne se
 * voit pas à la relecture, seulement à l'exécution.
 */

import { EXTENSIONS_IMAGE } from '../images/extensions.js';

/** La partie de FileSystemEntry qu'on utilise, écrite à la main pour rester testable. */
export interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  file(cb: (f: File) => void, err: (e: unknown) => void): void;
  createReader(): {
    readEntries(cb: (e: FsEntry[]) => void, err: (e: unknown) => void): void;
  };
}

/** Ce qu'on lit d'un DataTransfer. Le vrai type DOM ne se construit pas en test. */
export interface DropSource {
  items: ArrayLike<{ webkitGetAsEntry?: () => FsEntry | null }>;
  files: ArrayLike<File>;
}

/** Profondeur maximale. Un dossier de scans est plat ; au-delà, c'est autre chose. */
export const MAX_DEPTH = 4;

function entryFile(entry: FsEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(resolve, () => resolve(null));
  });
}

function readDir(entry: FsEntry): Promise<FsEntry[]> {
  const reader = entry.createReader();
  const all: FsEntry[] = [];
  // readEntries ne rend que 100 entrées à la fois, et ce n'est PAS une erreur :
  // il faut rappeler jusqu'à recevoir un lot vide. Un dossier de 2000 scans
  // demande vingt appels. S'arrêter au premier tronquerait le lot à 100 pages
  // sans rien signaler — et l'appariement recto/verso décalerait tout le reste.
  return new Promise((resolve) => {
    const next = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) return resolve(all);
          all.push(...batch);
          next();
        },
        () => resolve(all),
      );
    };
    next();
  });
}

async function walk(entry: FsEntry, out: File[], depth: number): Promise<void> {
  if (entry.isFile) {
    const f = await entryFile(entry);
    if (f) out.push(f);
    return;
  }
  if (entry.isDirectory && depth < MAX_DEPTH) {
    for (const child of await readDir(entry)) await walk(child, out, depth + 1);
  }
}

export async function filesFromDrop(dt: DropSource): Promise<File[]> {
  const roots: FsEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) roots.push(entry);
  }
  // Pas d'API d'entrées : on prend ce que le navigateur veut bien donner.
  if (roots.length === 0) return Array.from(dt.files);

  const out: File[] = [];
  for (const root of roots) await walk(root, out, 0);
  return out;
}

/**
 * Un `.tif` sorti d'un scanner arrive régulièrement avec un `type` vide : le
 * navigateur devine par extension et ne connaît pas toujours celle-là. Se fier
 * au seul type MIME jetterait des pages réellement scannées.
 */
export function estImage(f: { name: string; type: string }): boolean {
  return f.type.startsWith('image/') || EXTENSIONS_IMAGE.test(f.name);
}
