import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { embed, EMBED_DIM } from '../lib/fingerprint/embed.js';

/**
 * L'embedding CLIP sous concurrence.
 *
 * `embed` partage UNE SEULE pipeline onnxruntime entre tous les appels, et le
 * handler `fingerprint` tourne à `concurrency: 4`. Quatre images sont donc
 * encodées en même temps par la même pipeline, sur chaque lot.
 *
 * Si les résultats pouvaient se croiser, une carte recevrait l'embedding d'une
 * autre — et ce vecteur partirait dans `known_fingerprints`, où il servirait
 * ensuite de vérité pour toutes les occurrences suivantes. C'est le pire cas
 * imaginable : une erreur qui s'auto-propage, invisible, sur le chemin censé
 * rendre le coût marginal nul.
 *
 * On ne suppose pas que la pipeline est réentrante : on le vérifie.
 */
async function image(teinte: number): Promise<Buffer> {
  // Des images franchement différentes : si les vecteurs se croisaient, la
  // comparaison le verrait immédiatement.
  const svg = `<svg width="336" height="470" xmlns="http://www.w3.org/2000/svg">
      <rect width="336" height="470" fill="hsl(${teinte},70%,50%)"/>
      <circle cx="168" cy="${120 + teinte}" r="${60 + (teinte % 60)}"
              fill="hsl(${(teinte + 140) % 360},80%,35%)"/>
      <rect x="20" y="${300 + (teinte % 80)}" width="296" height="60"
            fill="hsl(${(teinte + 40) % 360},60%,20%)"/>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function cosinus(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

describe('embed en parallèle', () => {
  it('NE CROISE PAS LES VECTEURS entre encodages simultanés', async () => {
    const teintes = [0, 60, 120, 180, 240, 300];
    const images = await Promise.all(teintes.map((t) => image(t)));

    // Référence : une par une, sans aucune concurrence.
    const seuls: number[][] = [];
    for (const img of images) seuls.push(await embed(img));

    // Puis les six en même temps, comme le fait le worker.
    const ensemble = await Promise.all(images.map((img) => embed(img)));

    for (const [i, v] of ensemble.entries()) {
      expect(v).toHaveLength(EMBED_DIM);
      // Le même vecteur, à l'arrondi près : la pipeline est déterministe.
      expect(cosinus(v, seuls[i] as number[])).toBeGreaterThan(0.9999);
    }
  }, 300_000);

  it('des images différentes donnent des vecteurs différents', async () => {
    // Garde-fou du test précédent : si tout se ressemblait, la comparaison
    // ci-dessus ne prouverait rien.
    const [a, b] = await Promise.all([image(0), image(200)]);
    const [va, vb] = await Promise.all([embed(a as Buffer), embed(b as Buffer)]);
    expect(cosinus(va, vb)).toBeLessThan(0.99);
  }, 120_000);

  it('le vecteur est normalisé L2 — pgvector compte dessus', async () => {
    const v = await embed(await image(90));
    const norme = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norme).toBeCloseTo(1, 5);
  }, 120_000);
});
