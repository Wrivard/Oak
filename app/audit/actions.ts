'use server';

import { revalidatePath } from 'next/cache';
import { query, withTransaction } from '../../lib/db.js';
import { log } from '../../lib/log.js';

/**
 * Défaire une résolution automatique erronée.
 *
 * Ce n'est pas un simple « annuler ». Une mauvaise résolution a fait TROIS
 * choses, et les défaire à moitié laisserait le système dans un état pire que
 * l'erreur d'origine :
 *
 *   1. incrémenté une quantité d'inventaire  → à décrémenter
 *   2. écrit une EMPREINTE dans known_fingerprints → à supprimer, sinon toutes
 *      les occurrences suivantes de cette carte hériteront de la même erreur par
 *      le niveau 1. C'est le point le plus important.
 *   3. marqué le scan résolu → à renvoyer en review
 *
 * Tout se fait dans une transaction : à moitié fait serait pire que pas fait.
 */
/**
 * Revalidation qui ne peut pas faire échouer l'appelant.
 *
 * `revalidatePath` lève hors d'un contexte de requête Next — en test, par
 * exemple. Ce n'est jamais une raison de dire qu'une écriture en base a raté.
 */
function revalidateQuietly(path: string): void {
  try {
    revalidatePath(path);
  } catch (err) {
    log.debug('revalidation ignorée hors contexte de requête', { path, err });
  }
}

export interface ReopenResult {
  ok: boolean;
  error?: string;
  empreintesSupprimees?: number;
}

export async function reopenScan(scanId: string): Promise<ReopenResult> {
  const { rows } = await query<{ status: string; sku: string | null }>(
    'select status, resolved_sku as sku from scans where id = $1',
    [scanId],
  );
  const scan = rows[0];

  if (!scan) return { ok: false, error: 'scan introuvable' };
  if (scan.status !== 'resolved') {
    return { ok: false, error: 'ce scan n’est pas résolu' };
  }
  if (!scan.sku) return { ok: false, error: 'scan résolu sans SKU — incohérence' };

  try {
    const supprimees = await withTransaction(async (client) => {
      // La quantité d'abord : la contrainte CHECK (qty_on_hand >= 0) refusera si
      // la carte a déjà été vendue, et il vaut mieux échouer que descendre sous
      // zéro en silence.
      await client.query('select apply_qty_delta($1, -1, $2)', [
        scan.sku,
        'correction_audit',
      ]);

      // L'empreinte fausse, ensuite. C'est elle qui propagerait l'erreur.
      const del = await client.query(
        'delete from known_fingerprints where source_scan = $1',
        [scanId],
      );

      await client.query(
        `update scans
            set status = 'needs_review', match_source = null, confidence = null,
                resolved_sku = null, resolved_at = null,
                error = 'résolution automatique corrigée à la main'
          where id = $1`,
        [scanId],
      );

      return del.rowCount ?? 0;
    });

    log.warn('résolution automatique annulée', {
      scan_id: scanId,
      sku: scan.sku,
      empreintes_supprimees: supprimees,
    });

    // HORS du try qui décide du succès. Une revalidation qui échoue ferait
    // rapporter un ÉCHEC alors que la transaction est commitée — et un
    // utilisateur qui réessaie décrémenterait la quantité une seconde fois.
    // Rafraîchir l'écran est un confort ; corriger l'inventaire ne l'est pas.
    revalidateQuietly('/audit');
    return { ok: true, empreintesSupprimees: supprimees };
  } catch (err) {
    // Le cas attendu : la carte a déjà été vendue et la quantité tomberait sous
    // zéro. On le dit au lieu de laisser passer une incohérence.
    log.error('annulation impossible', { scan_id: scanId, err });
    return {
      ok: false,
      error:
        err instanceof Error && /qty_on_hand/.test(err.message)
          ? 'quantité déjà à zéro — la carte a probablement été vendue, corrige à la main'
          : String(err),
    };
  }
}
