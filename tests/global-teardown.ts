/**
 * Nettoyage de fin de suite : les jobs ORPHELINS.
 *
 * Le problème, mesuré : après chaque exécution complète, le tableau de santé
 * affichait « Jobs morts (24 h) : 7 » en rouge, tous du type `match` et tous
 * avec « scan … introuvable ». Une alarme fausse sur le seul écran qui doit
 * rester croyable.
 *
 * La course qui les produit : un test crée un scan `pending`, le worker du
 * lanceur — qui tourne en permanence sur la même base — le prend, calcule ses
 * empreintes et enfile un `match`. Si cet enfilage tombe APRÈS la purge des
 * jobs du test et AVANT celle des scans, le job survit à son scan. Le worker le
 * reprend, ne trouve plus rien, et le marque mort. C'est correct de sa part :
 * en production un scan ne se supprime jamais (invariant 7), donc un job sans
 * scan y serait une vraie anomalie.
 *
 * Réordonner les purges de chaque fichier ne suffirait pas — la course se
 * rejouerait simplement à un autre endroit. On balaie donc une fois à la fin,
 * sur le seul critère qui ne se discute pas : un job dont le scan n'existe
 * plus ne peut plus jamais aboutir.
 *
 * `running` est épargné : ne pas retirer une ligne sous un worker qui la tient.
 */
import { closePool, query } from '../lib/db.js';

export async function teardown(): Promise<void> {
  try {
    const res = await query(
      `delete from jobs
        where type in ('fingerprint', 'match')
          and status <> 'running'
          and payload ? 'scan_id'
          and not exists (
            select 1 from scans s where s.id::text = payload->>'scan_id')`,
    );
    if ((res.rowCount ?? 0) > 0) {
      // eslint-disable-next-line no-console
      console.log(`  ${res.rowCount} job(s) orphelin(s) retiré(s) après la suite.`);
    }
  } finally {
    await closePool();
  }
}
