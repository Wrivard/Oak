import { readFile } from 'node:fs/promises';
import { query } from '../../lib/db.js';
import { THRESHOLDS } from '../../lib/config/thresholds.js';
import { log } from '../../lib/log.js';
import { readCardNumbers } from '../../lib/ocr/number.js';
import {
  applyResolution,
  type Identity,
  type MatchSource,
} from '../../lib/resolution.js';
import type { CardCondition, CardVariant } from '../../lib/sku.js';
import { PermanentError } from '../queue/errors.js';
import type { Job } from '../queue/queue.js';

/**
 * Résolution en trois niveaux. Voir docs/02-ingest-and-matching.md §4 et le
 * skill card-matching-thresholds.
 *
 * Tous les seuils viennent de lib/config/thresholds.ts. Aucune valeur numérique
 * de seuil ici — c'est un invariant, pas une préférence de style.
 */
interface ScanContext {
  id: string;
  status: string;
  front_path: string;
  phash_front: string | null;
  dhash_front: string | null;
  embedding: string | null;
  default_variant: CardVariant;
  default_condition: CardCondition;
  default_language: string;
}

interface Candidate {
  card_id: string;
  name: string;
  set_name: string;
  distance: number;
}

export async function handleMatch(job: Job): Promise<void> {
  const scanId = job.payload['scan_id'];
  if (typeof scanId !== 'string') {
    throw new PermanentError(`payload sans scan_id: ${JSON.stringify(job.payload)}`);
  }

  const scan = await loadScan(scanId);
  if (!scan) throw new PermanentError(`scan ${scanId} introuvable`);

  // Rejouabilité : un scan déjà résolu ne doit jamais réincrémenter une quantité.
  if (scan.status !== 'fingerprinted') {
    log.debug('scan déjà traité, job ignoré', { scan_id: scanId, status: scan.status });
    return;
  }
  if (scan.phash_front === null || scan.dhash_front === null || scan.embedding === null) {
    throw new PermanentError(`scan ${scanId} sans empreintes`);
  }

  // ---- NIVEAU 1 — tes scans confirmés -------------------------------------
  const own = await matchOwnHistory(scan);
  if (own) {
    // Le variant ne se devine jamais (skill §6). S'il diverge du défaut de
    // session, c'est un conflit : reverse holo vs normal, c'est 5 à 20x d'écart
    // de prix. On ne tranche pas à la machine.
    if (own.identity.variant !== scan.default_variant) {
      await sendToReview(scan, [], { variantConflict: true });
      log.info('conflit de variant, envoyé en review', {
        scan_id: scanId,
        vu: own.identity.variant,
        defaut_session: scan.default_variant,
      });
      return;
    }
    await resolveScan(scan, own.identity, 'own_history', own.confidence);
    log.info('scan résolu', {
      scan_id: scanId,
      source: 'own_history',
      card_id: own.identity.card_id,
    });
    return;
  }

  // ---- NIVEAU 2 — catalogue -----------------------------------------------
  const level2 = await matchCatalog(scan);

  // La lecture OCR est enregistrée AVANT de brancher : qu'on résolve ou non,
  // c'est la donnée de l'expérience 1bis, et elle vaut sur les deux issues.
  await recordOcr(scan.id, level2);

  if (level2.resolved) {
    await resolveScan(
      scan,
      level2.resolved.identity,
      'catalog',
      level2.resolved.confidence,
    );
    log.info('scan résolu', {
      scan_id: scanId,
      source: 'catalog',
      card_id: level2.resolved.identity.card_id,
    });
    return;
  }

  // ---- NIVEAU 3 — review manuelle -----------------------------------------
  // Pas de fallback automatique (docs/02 §5). On soigne en revanche ce que la
  // review reçoit : si l'OCR n'a rien donné, on remonte quand même les plus
  // proches voisins CLIP du catalogue entier. Ça ne résout pas, mais ça évite à
  // l'humain de partir d'une page blanche — et c'est là qu'est le coût réel.
  const forReview =
    level2.candidates.length > 0
      ? level2.candidates
      : await nearestFromCatalog(scan.embedding);

  await sendToReview(scan, forReview, { variantConflict: false });
  log.info('scan envoyé en review', {
    scan_id: scanId,
    candidats: forReview.length,
    ocr_lu: level2.numberRead,
  });
}

/**
 * Enregistre ce que l'OCR a lu.
 *
 * Sans ça, diagnostiquer «pourquoi cette carte est partie en review» oblige à
 * rejouer le pipeline à la main. Voir migration 007.
 */
async function recordOcr(
  scanId: string,
  level2: { numberRead: string | null; ocrConfidence: number | null; ocrBand: number | null },
): Promise<void> {
  await query(
    `update scans
        set ocr_read = $2, ocr_confidence = $3, ocr_band = $4
      where id = $1`,
    [scanId, level2.numberRead, level2.ocrConfidence, level2.ocrBand],
  );
}

async function loadScan(scanId: string): Promise<ScanContext | null> {
  const { rows } = await query<ScanContext>(
    `select s.id, s.status, s.front_path,
            s.phash_front::text as phash_front,
            s.dhash_front::text as dhash_front,
            s.embedding::text   as embedding,
            ss.default_variant, ss.default_condition, ss.default_language
       from scans s join sessions ss on ss.id = s.session_id
      where s.id = $1`,
    [scanId],
  );
  return rows[0] ?? null;
}

/**
 * Niveau 1. Les deux hachages, jamais un seul : des cartes différentes peuvent
 * partager de l'information fréquentielle. Le tri se fait sur la somme, qui est
 * ce qui sépare réellement (docs/02 §3).
 */
async function matchOwnHistory(
  scan: ScanContext,
): Promise<{ identity: Identity; confidence: number } | null> {
  const { rows } = await query<Identity & { d_p: number; d_d: number }>(
    `select card_id, variant, condition, language,
            bit_count(phash # $1::bit(64)) as d_p,
            bit_count(dhash # $2::bit(64)) as d_d
       from known_fingerprints
      where bit_count(phash # $1::bit(64)) <= $3
        and bit_count(dhash # $2::bit(64)) <= $4
      order by (bit_count(phash # $1::bit(64)) + bit_count(dhash # $2::bit(64)))
      limit 1`,
    [
      scan.phash_front,
      scan.dhash_front,
      THRESHOLDS.ownHistory.phashMax,
      THRESHOLDS.ownHistory.dhashMax,
    ],
  );

  const hit = rows[0];
  if (!hit) return null;

  const budget = THRESHOLDS.ownHistory.phashMax + THRESHOLDS.ownHistory.dhashMax;
  const confidence = Math.max(0, 1 - (Number(hit.d_p) + Number(hit.d_d)) / budget);

  return {
    identity: {
      card_id: hit.card_id,
      variant: hit.variant,
      condition: hit.condition,
      language: hit.language,
    },
    confidence,
  };
}

/**
 * Niveau 2. OCR du numéro, filtre déterministe, rerank CLIP.
 *
 * L'OCR propose plusieurs lectures (le bloc numéro est à gauche sur le moderne,
 * à droite sur le vintage) et c'est le CATALOGUE qui arbitre : une lecture
 * erronée ne correspond à aucune carte et s'élimine seule. On s'arrête à la
 * première lecture qui produit des candidats.
 */
async function matchCatalog(scan: ScanContext): Promise<{
  candidates: Candidate[];
  resolved: { identity: Identity; confidence: number } | null;
  numberRead: string | null;
  ocrConfidence: number | null;
  ocrBand: number | null;
}> {
  let image: Buffer;
  try {
    image = await readFile(scan.front_path);
  } catch (err) {
    // Ambiguë, pas permanente : le watcher commit avant de déplacer le fichier.
    throw new Error(`image illisible pour le scan ${scan.id}: ${String(err)}`);
  }

  let candidates: Candidate[] = [];
  let numberRead: string | null = null;
  let ocrConfidence: number | null = null;
  let ocrBand: number | null = null;

  await readCardNumbers(image, async (reading) => {
    // On enregistre CHAQUE lecture tentée, même celle qui ne donnera rien : le
    // diagnostic a besoin de savoir ce que tesseract a cru voir, pas seulement
    // ce qui a été validé.
    numberRead ??= `${reading.number}/${reading.printedTotal ?? '-'}`;
    ocrConfidence ??= reading.confidence;
    ocrBand ??= reading.band;
    const found = await filterAndRerank(
      reading.number,
      reading.printedTotal,
      scan.default_language,
      scan.embedding as string,
    );
    if (found.length === 0) return false;
    candidates = found;
    // La lecture VALIDÉE remplace la première tentative.
    numberRead = `${reading.number}/${reading.printedTotal ?? '-'}`;
    ocrConfidence = reading.confidence;
    ocrBand = reading.band;
    return true;
  });

  if (candidates.length === 0) {
    return { candidates, resolved: null, numberRead, ocrConfidence, ocrBand };
  }

  const best = candidates[0] as Candidate;
  const second = candidates[1];

  // Seuil absolu ET marge. La marge est ce qui attrape les artworks réimprimés
  // et les promos — ne jamais la retirer pour gonfler l'auto-résolution.
  const withinThreshold = Number(best.distance) < THRESHOLDS.catalog.cosineMax;
  const margin = second ? Number(second.distance) - Number(best.distance) : Infinity;
  const separated = margin >= THRESHOLDS.catalog.minMargin;

  if (!withinThreshold || !separated) {
    return { candidates, resolved: null, numberRead, ocrConfidence, ocrBand };
  }

  return {
    candidates,
    resolved: {
      identity: {
        card_id: best.card_id,
        variant: scan.default_variant,
        condition: scan.default_condition,
        language: scan.default_language,
      },
      confidence: 1 - Number(best.distance) / THRESHOLDS.catalog.cosineMax,
    },
    numberRead,
    ocrConfidence,
    ocrBand,
  };
}

/**
 * Filtre déterministe puis rerank cosinus. Le filtre RÉDUIT (45 % des cartes
 * sortent seules), le rerank tranche.
 *
 * Le fallback `total = Y` couvre les sets dont le dénominateur imprimé n'est pas
 * le printedTotal. Attention : `total` peut être INFÉRIEUR à `printed_total`
 * (set swshp : 307 imprimées, 304 au total).
 */
async function filterAndRerank(
  number: string,
  printedTotal: number | null,
  language: string,
  embedding: string,
): Promise<Candidate[]> {
  const { rows } = await query<Candidate>(
    `select c.id as card_id, c.name, c.set_name,
            (e.embedding <=> $4::vector) as distance
       from cards c
       join card_embeddings e on e.card_id = c.id
      where c.number = $1
        and c.language = $3
        and ($2::int is null
             or c.printed_total = $2::int
             or c.total = $2::int)
      order by distance
      limit 5`,
    [number, printedTotal, language, embedding],
  );
  return rows;
}

/**
 * Plus proches voisins sur le catalogue entier, via l'index HNSW. Sert
 * uniquement à pré-remplir la review quand l'OCR n'a rien lu — jamais à
 * résoudre automatiquement : sans le filtre déterministe, rien ne garantit que
 * le bon candidat soit même dans la liste.
 */
async function nearestFromCatalog(embedding: string): Promise<Candidate[]> {
  const { rows } = await query<Candidate>(
    `select c.id as card_id, c.name, c.set_name,
            (e.embedding <=> $1::vector) as distance
       from card_embeddings e join cards c on c.id = e.card_id
      order by e.embedding <=> $1::vector
      limit 5`,
    [embedding],
  );
  return rows;
}

/** Adaptateur : le scan porte déjà ses empreintes, lib/resolution fait le reste. */
async function resolveScan(
  scan: ScanContext,
  identity: Identity,
  source: MatchSource,
  confidence: number,
): Promise<void> {
  await applyResolution({
    scanId: scan.id,
    identity,
    source,
    confidence,
    phash: scan.phash_front as string,
    dhash: scan.dhash_front as string,
    embedding: scan.embedding as string,
  });
}

async function sendToReview(
  scan: ScanContext,
  candidates: Candidate[],
  opts: { variantConflict: boolean },
): Promise<void> {
  await query(
    `update scans
        set status = 'needs_review', candidates = $2::jsonb, variant_conflict = $3
      where id = $1`,
    [scan.id, JSON.stringify(candidates), opts.variantConflict],
  );
}
