import {
  env,
  pipeline,
  RawImage,
  type ImageFeatureExtractionPipeline,
} from '@xenova/transformers';

/**
 * Embedding CLIP. Voir docs/02-ingest-and-matching.md §3.
 *
 * Xenova/clip-vit-base-patch32, 512 dimensions, ONNX sur CPU. Pas de GPU, pas
 * d'appel réseau après le premier téléchargement du modèle, pas de coût par carte.
 *
 * NE CHANGE JAMAIS DE MODÈLE sans reconstruire card_embeddings ET
 * known_fingerprints en entier. Un embedding d'un modèle n'est pas comparable à
 * celui d'un autre : la colonne `model` existe pour t'empêcher de mélanger.
 */
export const EMBED_MODEL = 'clip-vit-base-patch32';
export const EMBED_DIM = 512;

const HF_MODEL = 'Xenova/clip-vit-base-patch32';

// Le modèle est mis en cache sur disque au premier appel (~90 Mo).
env.allowLocalModels = false;

let extractor: Promise<ImageFeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<ImageFeatureExtractionPipeline> {
  extractor ??= pipeline('image-feature-extraction', HF_MODEL, {
    quantized: true,
  }) as Promise<ImageFeatureExtractionPipeline>;
  return extractor;
}

/**
 * Renvoie un vecteur de 512 flottants normalisé L2 (norme 1,0), pour que la
 * distance cosinus de pgvector soit propre.
 */
export async function embed(input: Buffer): Promise<number[]> {
  const image = await RawImage.fromBlob(new Blob([new Uint8Array(input)]));

  const extract = await getExtractor();
  const output = await extract(image);

  const raw = Array.from(output.data as Float32Array);
  if (raw.length !== EMBED_DIM) {
    throw new Error(`embed: ${raw.length} dimensions au lieu de ${EMBED_DIM}`);
  }
  return l2normalize(raw);
}

export function l2normalize(v: readonly number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) throw new Error('embed: vecteur nul, normalisation impossible');
  return v.map((x) => x / norm);
}

/** Littéral pgvector : '[0.1,0.2,...]'. */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}
