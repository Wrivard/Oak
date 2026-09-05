import { query } from '../lib/db.js';
import { log } from '../lib/log.js';

/**
 * Récupère les scans abandonnés par un job mort.
 *
 * Un job qui meurt est visible — le tableau de santé alarme dès le premier.
 * Mais le SCAN, lui, restait dans son état de traitement pour toujours. Et la
 * clôture d'un lot refuse tant qu'une carte est en traitement : un seul job mort
 * rendait donc la réconciliation d'un lot entier impossible, sur le contrôle qui
 * est justement le seul à rattraper une carte physique sans ligne d'inventaire.
 *
 * Deux issues, et la distinction compte :
 *
 * `pending` — l'empreinte a échoué. Sans empreinte, la review ne peut RIEN en
 * faire : `confirmScan` refuse un scan sans empreintes, précisément pour qu'une
 * résolution n'échappe pas à `known_fingerprints`. La carte n'est pas
 * identifiable depuis l'application, il faut la repasser au scanner. On l'écarte
 * donc — la ligne reste, comptée dans la réconciliation, avec la raison.
 *
 * `fingerprinted` / `matched` — le matching a échoué, mais le scan porte son
 * image et ses empreintes. C'est exactement ce que le niveau 3 est censé
 * recevoir : un humain tranche. On l'envoie en review.
 *
 * Le rattrapage est idempotent : un scan déjà sorti de ces états n'est pas
 * retouché.
 */
export interface ReapResult {
  ecartes: number;
  envoyesEnReview: number;
}

export async function reapStrandedScans(): Promise<ReapResult> {
  const ecartes = await query(
    `update scans s
        set status = 'rejected',
            error = 'empreinte impossible, carte à repasser au scanner : '
                    || coalesce(j.last_error, 'cause inconnue'),
            resolved_at = now()
       from jobs j
      where j.status = 'dead'
        and j.type = 'fingerprint'
        and j.payload->>'scan_id' = s.id::text
        and s.status = 'pending'`,
  );

  const enReview = await query(
    `update scans s
        set status = 'needs_review',
            error = 'matching automatique abandonné : '
                    || coalesce(j.last_error, 'cause inconnue')
       from jobs j
      where j.status = 'dead'
        and j.type = 'match'
        and j.payload->>'scan_id' = s.id::text
        and s.status in ('fingerprinted', 'matched')`,
  );

  const res: ReapResult = {
    ecartes: ecartes.rowCount ?? 0,
    envoyesEnReview: enReview.rowCount ?? 0,
  };

  if (res.ecartes > 0 || res.envoyesEnReview > 0) {
    log.warn('scans récupérés après un job mort', { ...res });
  }
  return res;
}
