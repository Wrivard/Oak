import sharp from 'sharp';

/**
 * Empreintes perceptuelles. Voir docs/02-ingest-and-matching.md §3.
 *
 * Deux techniques, pas une. pHash travaille en fréquentiel (DCT), dHash en
 * gradient horizontal. Des cartes différentes peuvent partager de l'information
 * fréquentielle ; croiser les deux fait tomber les faux positifs.
 *
 * Les deux renvoient une chaîne de 64 caractères '0'/'1', qui est la forme
 * littérale d'un `bit(64)` Postgres. La distance de Hamming se calcule en base
 * avec `bit_count(a # b)`, pas en TypeScript.
 */
const PHASH_SIZE = 32; // image de travail avant DCT
const PHASH_LOW = 8; // coin basse fréquence conservé
const DHASH_W = 9;
const DHASH_H = 8;

export type Bits64 = string;

/** Niveaux de gris bruts, sans alpha, en `size × size`. */
async function grayscale(input: Buffer, w: number, h: number): Promise<Uint8Array> {
  const { data } = await sharp(input)
    .greyscale()
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * DCT-II 1D, implémentation directe. O(n²) sur n=32 : 1024 opérations par ligne,
 * négligeable devant le décodage JPEG qui précède. Pas de dépendance externe pour
 * ça — une FFT ici serait de l'optimisation prématurée sur le mauvais maillon.
 */
function dct1d(input: Float64Array): Float64Array {
  const n = input.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += (input[i] as number) * Math.cos(((2 * i + 1) * k * Math.PI) / (2 * n));
    }
    out[k] = sum * (k === 0 ? Math.SQRT1_2 : 1);
  }
  return out;
}

function dct2d(pixels: Uint8Array, size: number): Float64Array {
  const rows = new Float64Array(size * size);
  const row = new Float64Array(size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) row[x] = pixels[y * size + x] as number;
    const t = dct1d(row);
    for (let x = 0; x < size; x++) rows[y * size + x] = t[x] as number;
  }

  const out = new Float64Array(size * size);
  const col = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) col[y] = rows[y * size + x] as number;
    const t = dct1d(col);
    for (let y = 0; y < size; y++) out[y * size + x] = t[y] as number;
  }
  return out;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * pHash 64 bits : grayscale → 32×32 → DCT-II → coin 8×8 basse fréquence →
 * médiane → bits.
 *
 * Le terme DC (0,0) est exclu du calcul de la médiane : il porte la luminance
 * moyenne, qui varie avec l'exposition du scanner et écraserait la médiane.
 */
export async function phash(input: Buffer): Promise<Bits64> {
  const pixels = await grayscale(input, PHASH_SIZE, PHASH_SIZE);
  const dct = dct2d(pixels, PHASH_SIZE);

  const low: number[] = [];
  for (let y = 0; y < PHASH_LOW; y++) {
    for (let x = 0; x < PHASH_LOW; x++) low.push(dct[y * PHASH_SIZE + x] as number);
  }

  const med = median(low.slice(1));
  return low.map((v) => (v > med ? '1' : '0')).join('');
}

/**
 * dHash 64 bits : 9×8 en niveaux de gris, chaque pixel comparé à son voisin de
 * droite. Insensible à la luminance globale par construction — c'est ce qui le
 * rend complémentaire du pHash.
 */
export async function dhash(input: Buffer): Promise<Bits64> {
  const pixels = await grayscale(input, DHASH_W, DHASH_H);

  const bits: string[] = [];
  for (let y = 0; y < DHASH_H; y++) {
    for (let x = 0; x < DHASH_W - 1; x++) {
      const left = pixels[y * DHASH_W + x] as number;
      const right = pixels[y * DHASH_W + x + 1] as number;
      bits.push(left > right ? '1' : '0');
    }
  }
  return bits.join('');
}

/**
 * Distance de Hamming entre deux empreintes. Réservée aux tests et au débogage :
 * en production la comparaison se fait en SQL avec `bit_count(a # b)`, sur index.
 */
export function hamming(a: Bits64, b: Bits64): number {
  if (a.length !== b.length) {
    throw new Error(`hamming: longueurs différentes (${a.length} vs ${b.length})`);
  }
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
