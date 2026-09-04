import sharp from 'sharp';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import { THRESHOLDS } from '../config/thresholds.js';
import { log } from '../log.js';

/**
 * Lecture du bloc numéro d'une carte. C'est l'entrée du niveau 2 : sans `X/Y`,
 * le filtre déterministe n'a rien sur quoi mordre et la carte part en review.
 *
 * ATTENTION — la géométrie du crop n'est pas calibrée. L'expérience 1bis de
 * PROMPTS.md doit mesurer le taux de lecture correcte, ventilé par ère, avant
 * qu'on considère ce module comme réglé. La position du bloc varie selon l'ère
 * et un crop serré rate le vintage.
 */
export interface CardNumber {
  /** Numérateur, tel qu'imprimé : "4", "207", "SWSH284". */
  number: string;
  /** Dénominateur, absent sur les promos. */
  printedTotal: number | null;
  confidence: number;
  raw: string;
}

let worker: Promise<TesseractWorker> | undefined;

function getWorker(): Promise<TesseractWorker> {
  worker ??= createWorker('eng');
  return worker;
}

export async function disposeOcr(): Promise<void> {
  if (!worker) return;
  const w = await worker;
  await w.terminate();
  worker = undefined;
}

/**
 * Isole la bande basse-gauche et l'agrandit. Niveaux de gris + normalisation :
 * le fond des cartes modernes est chargé, tesseract s'en sort beaucoup mieux
 * sur du contraste franc.
 */
export interface Band {
  top: number;
  left: number;
  width: number;
}

/**
 * Isole une bande et l'agrandit. Niveaux de gris + normalisation : le fond des
 * cartes modernes est chargé, tesseract s'en sort beaucoup mieux sur du
 * contraste franc.
 */
export async function cropBand(input: Buffer, band: Band): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0) throw new Error('cropBand: image sans dimensions');

  const top = Math.floor(h * band.top);
  const left = Math.floor(w * band.left);
  const width = Math.max(1, Math.floor(w * band.width));

  return sharp(input)
    .extract({ left, top, width: Math.min(width, w - left), height: Math.max(1, h - top) })
    .greyscale()
    .normalise()
    .resize({ width: Math.max(3, Math.floor(width * THRESHOLDS.ocr.upscale)) })
    .png()
    .toBuffer();
}

/**
 * Deux formes acceptées, dans cet ordre de priorité :
 *   "004/102", "4/102"  → numéro + dénominateur
 *   "SWSH284", "XY177"  → promo, aucun dénominateur
 *
 * Le zéro de tête est retiré : le catalogue stocke "4", pas "004".
 */
export function parseNumberText(text: string): Omit<CardNumber, 'confidence'> | null {
  const clean = text.replace(/\s+/g, ' ').trim();

  const fraction = /\b([A-Z]{0,4}\d{1,3})\s*\/\s*(\d{1,3})\b/i.exec(clean);
  if (fraction) {
    return {
      number: stripLeadingZeros(fraction[1] as string),
      printedTotal: Number(fraction[2]),
      raw: clean,
    };
  }

  // Promo : lettres puis chiffres, sans dénominateur. Au moins deux lettres pour
  // ne pas confondre avec un numéro de HP ou un code de bloc.
  const promo = /\b([A-Z]{2,5}\d{1,4})\b/.exec(clean.toUpperCase());
  if (promo) {
    return { number: promo[1] as string, printedTotal: null, raw: clean };
  }

  return null;
}

function stripLeadingZeros(s: string): string {
  const m = /^([A-Za-z]*)0*(\d+)$/.exec(s);
  return m ? `${m[1]}${m[2]}` : s;
}

/**
 * Lit le bloc numéro en essayant chaque bande configurée.
 *
 * Retourne TOUTES les lectures plausibles, dédupliquées, les plus sûres d'abord.
 * C'est volontaire : une lecture isolée n'est pas fiable — sur les cartes Base le
 * numéro est à droite, sur les modernes à gauche, et on ne connaît pas l'ère
 * avant d'avoir identifié la carte. C'est l'appelant qui tranche en confrontant
 * chaque lecture au catalogue : une lecture erronée ne correspond à aucune carte
 * et s'élimine d'elle-même.
 *
 * `onCandidate` permet d'arrêter dès qu'une lecture est validée, plutôt que de
 * payer les quatre passes OCR à chaque carte.
 */
export async function readCardNumbers(
  input: Buffer,
  onCandidate?: (c: CardNumber) => Promise<boolean>,
): Promise<CardNumber[]> {
  const w = await getWorker();
  const seen = new Set<string>();
  const out: CardNumber[] = [];

  for (const band of THRESHOLDS.ocr.bands) {
    let text: string;
    let confidence: number;
    try {
      const { data } = await w.recognize(await cropBand(input, band));
      text = data.text;
      confidence = data.confidence;
    } catch (err) {
      // Une bande trop petite ou illisible ne doit pas faire tomber les autres.
      log.debug('OCR: bande illisible', { band, err });
      continue;
    }

    const parsed = parseNumberText(text);
    if (!parsed) continue;
    if (confidence < THRESHOLDS.ocr.minConfidence) continue;

    const key = `${parsed.number}/${parsed.printedTotal ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const candidate: CardNumber = { ...parsed, confidence };
    out.push(candidate);

    if (onCandidate && (await onCandidate(candidate))) break;
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}
