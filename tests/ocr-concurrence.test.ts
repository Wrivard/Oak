import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { disposeOcr, readCardNumbers } from '../lib/ocr/number.js';

/**
 * L'OCR sous concurrence.
 *
 * `readCardNumbers` partage UN SEUL worker tesseract entre tous les appels, et
 * le handler `match` tourne à `concurrency: 2`. Deux cartes sont donc lues en
 * même temps par le même worker, sur chaque lot, en permanence.
 *
 * Si les résultats pouvaient se croiser, deux cartes échangeraient leur numéro
 * — et le filtre déterministe du niveau 2 les résoudrait toutes les deux vers la
 * mauvaise carte, avec une confiance élevée. Ce n'est pas une erreur qui se
 * verrait : la review ne les recevrait même pas.
 *
 * Ce test lit six images DIFFÉRENTES en parallèle et vérifie que chacune rend
 * son propre numéro.
 */
async function carte(numero: string, total: number): Promise<Buffer> {
  // Le bloc numéro en bas à gauche, comme sur le moderne : c'est la bande 0.
  const svg = `<svg width="600" height="840" xmlns="http://www.w3.org/2000/svg">
      <rect width="600" height="840" fill="#ffffff"/>
      <rect x="0" y="0" width="600" height="720" fill="#dddddd"/>
      <text x="30" y="800" font-family="DejaVu Sans, Arial, sans-serif"
            font-size="46" font-weight="bold" fill="#000000">${numero}/${total}</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

afterAll(async () => {
  await disposeOcr();
});

describe('readCardNumbers en parallèle', () => {
  it('NE CROISE PAS LES RÉSULTATS entre lectures simultanées', async () => {
    const attendus = ['4', '25', '77', '102', '13', '58'];

    const images = await Promise.all(attendus.map((n) => carte(n, 102)));
    const lectures = await Promise.all(images.map((img) => readCardNumbers(img)));

    // On n'exige pas que tesseract lise tout — c'est justement ce que
    // l'expérience 1bis mesure. On exige qu'il ne rende JAMAIS le numéro d'une
    // autre image.
    let lus = 0;
    for (const [i, res] of lectures.entries()) {
      if (res.length === 0) continue;
      lus += 1;
      const numeros = res.map((r) => r.number);
      expect(numeros).toContain(attendus[i]);
    }

    // Et au moins la moitié doit être lue, sinon le test ne prouve rien.
    expect(lus).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
