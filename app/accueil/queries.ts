import { query } from '../../lib/db.js';

/**
 * Ce qui attend une décision HUMAINE.
 *
 * À ne pas confondre avec le tableau de santé, qui répond à « est-ce que la
 * machine tourne ». Celui-ci répond à « qu'est-ce que j'ai à faire ». Une
 * machine parfaitement saine peut avoir cent cinq cartes en attente de review,
 * trois lots qu'on a oublié de fermer et soixante-dix SKUs sans prix : rien n'y
 * est en panne, et pourtant rien n'avance.
 *
 * Chaque entrée porte un COMPTE et une DESTINATION. Une tâche sans chiffre ne
 * dit pas si elle vaut le coup d'être commencée ; une tâche sans lien se
 * traduit à la main en trois clics.
 */
export interface Tache {
  cle: string;
  titre: string;
  detail: string;
  compte: number;
  /** L'unité du compte, pour que « 3 » ne soit pas ambigu. */
  unite: string;
  lien: string;
  /** `faire` : du travail. `verifier` : un contrôle. `alerte` : ça bloque. */
  ton: 'faire' | 'verifier' | 'alerte';
}

interface Ligne {
  review: string;
  lots_sans_comptage: string;
  lots_a_fermer: string;
  sans_prix: string;
  non_listes: string;
  a_verifier: string;
  worker_muet: boolean;
}

export async function loadTaches(): Promise<Tache[]> {
  const { rows } = await query<Ligne>(
    `select
       (select count(*) from scans where status = 'needs_review')::text as review,

       -- Un lot ouvert dont on n'a pas saisi le comptage attendu : la
       -- réconciliation ne pourra rien vérifier à la fermeture.
       (select count(*) from sessions
         where status = 'open' and expected_count is null)::text as lots_sans_comptage,

       -- Un lot ouvert dont plus rien n'attend : il ne manque que la fermeture.
       (select count(*) from sessions ss
         where ss.status = 'open'
           and exists (select 1 from scans s where s.session_id = ss.id)
           and not exists (
             select 1 from scans s
              where s.session_id = ss.id
                and s.status in ('pending','fingerprinted','matched','needs_review')
           ))::text as lots_a_fermer,

       (select count(*) from inventory
         where qty_on_hand > 0 and current_price is null)::text as sans_prix,

       (select count(*) from inventory
         where qty_on_hand > 0 and current_price is not null
           and ebay_listing_id is null)::text as non_listes,

       -- Les résolutions automatiques jamais regardées. Une résolution fausse
       -- écrit une empreinte qui contamine toutes les suivantes.
       (select count(*) from scans
         where status = 'resolved' and match_source in ('own_history','catalog'))::text
         as a_verifier,

       -- Des jobs prêts depuis plus de deux minutes et rien de terminé pendant
       -- ce temps : personne ne draine.
       (select count(*) from jobs
          where status in ('queued','failed')
            and run_after < now() - interval '2 minutes') > 0
       and (select count(*) from jobs
             where completed_at > now() - interval '2 minutes') = 0 as worker_muet`,
  );

  const r = rows[0];
  if (r === undefined) return [];
  const n = (v: string): number => Number(v) || 0;

  const taches: Tache[] = [];

  // L'ORDRE EST LE PLAN DE TRAVAIL, pas un classement par importance. Ce qui
  // bloque tout passe devant ; ensuite le trajet d'une carte : trier, fermer,
  // prixer, lister, vérifier.
  if (r.worker_muet) {
    taches.push({
      cle: 'worker',
      titre: 'Le worker ne tourne pas',
      detail:
        'Des jobs attendent sans que rien n’avance. Tant qu’il est arrêté, ' +
        'rien de ce que tu envoies ne sera traité.',
      compte: 0,
      unite: '',
      lien: '/dashboard',
      ton: 'alerte',
    });
  }

  if (n(r.review) > 0) {
    taches.push({
      cle: 'review',
      titre: 'Cartes à identifier',
      detail: 'Le niveau 3 : ce que les empreintes et le catalogue n’ont pas tranché.',
      compte: n(r.review),
      unite: 'carte',
      lien: '/review',
      ton: 'faire',
    });
  }

  if (n(r.lots_a_fermer) > 0) {
    taches.push({
      cle: 'fermer',
      titre: 'Lots triés, pas encore fermés',
      detail:
        'Plus rien n’attend dedans. La fermeture réconcilie le comptage — ' +
        'c’est le seul contrôle qui attrape une carte physique perdue.',
      compte: n(r.lots_a_fermer),
      unite: 'lot',
      lien: '/batches?statut=open',
      ton: 'faire',
    });
  }

  if (n(r.lots_sans_comptage) > 0) {
    taches.push({
      cle: 'comptage',
      titre: 'Lots ouverts sans comptage attendu',
      detail:
        'Sans le nombre de cartes réellement passées au scanner, la ' +
        'réconciliation ne vérifiera rien à la fermeture.',
      compte: n(r.lots_sans_comptage),
      unite: 'lot',
      lien: '/batches?statut=open',
      ton: 'verifier',
    });
  }

  if (n(r.sans_prix) > 0) {
    taches.push({
      cle: 'sans-prix',
      titre: 'SKUs en stock sans prix',
      detail:
        'Chacun a une raison, affichée dans sa fiche. Un prix manquant n’est ' +
        'jamais deviné : la carte ne part pas.',
      compte: n(r.sans_prix),
      unite: 'SKU',
      lien: '/inventory?filter=unpriced',
      ton: 'verifier',
    });
  }

  if (n(r.non_listes) > 0) {
    taches.push({
      cle: 'non-listes',
      titre: 'SKUs prixés, pas encore en vente',
      detail: 'Ils ont un prix et une quantité, mais aucune annonce eBay.',
      compte: n(r.non_listes),
      unite: 'SKU',
      lien: '/inventory?filter=unlisted',
      ton: 'faire',
    });
  }

  if (n(r.a_verifier) > 0) {
    taches.push({
      cle: 'verifier',
      titre: 'Résolutions automatiques à contrôler',
      detail:
        'Une résolution fausse écrit une empreinte, et toutes les occurrences ' +
        'suivantes de cette carte en héritent.',
      compte: n(r.a_verifier),
      unite: 'carte',
      lien: '/audit?sort=doubtful',
      ton: 'verifier',
    });
  }

  return taches;
}
