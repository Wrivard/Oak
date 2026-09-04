import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Images de cartes réelles pour les tests d'empreintes, mises en cache sur disque.
 *
 * Volontairement PAS commitées : ce sont des renders officiels sous copyright, et
 * ce repo est public. Elles se téléchargent une fois puis restent en cache local
 * (répertoire gitignoré).
 */
const CACHE = join(dirname(fileURLToPath(import.meta.url)), 'cards');

export const CARDS = {
  charizard: 'https://images.pokemontcg.io/base1/4.png',
  blastoise: 'https://images.pokemontcg.io/base1/2.png',
  alakazam: 'https://images.pokemontcg.io/base1/1.png',
  chansey: 'https://images.pokemontcg.io/base1/3.png',
} as const;

export type CardKey = keyof typeof CARDS;

export async function cardImage(key: CardKey): Promise<Buffer> {
  const path = join(CACHE, `${key}.png`);
  try {
    return await readFile(path);
  } catch {
    const res = await fetch(CARDS[key]);
    if (!res.ok) throw new Error(`fixture ${key} : HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, buf);
    return buf;
  }
}
