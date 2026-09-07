import { query } from '../../lib/db.js';

/**
 * Compteurs affichés en permanence dans la barre latérale.
 *
 * Une seule requête, volontairement : elle tourne sur CHAQUE page, et un
 * aller-retour supplémentaire par page se paie sur toute la session.
 *
 * En cas d'échec on rend des valeurs neutres plutôt que de faire tomber la
 * page : une base injoignable doit casser la page qui en a besoin, pas la
 * navigation.
 */
export interface ShellCounts {
  review: number;
  health: 'ok' | 'warn' | 'alarm';
  /**
   * Des jobs attendent depuis longtemps sans que rien n'avance.
   *
   * C'est l'erreur d'exploitation la plus probable : on ferme la fenêtre du
   * worker sans y penser, on envoie un lot, et rien ne se passe — sans aucune
   * explication à l'écran. Le pipeline ne peut pas se réparer tout seul, mais il
   * peut le DIRE.
   */
  workerMuet: boolean;
  enAttente: number;
  /**
   * Les lots qui ont encore des cartes en review, du plus récent au plus
   * ancien.
   *
   * Ils alimentent la palette : « Ctrl+K, bulk » doit mener aux dix-neuf cartes
   * de `bulk-vintage`, pas obliger à passer par l'écran des lots pour recopier
   * un nom. C'est la même requête que les compteurs — un aller-retour de plus
   * par page se paierait sur toute la session.
   */
  lots: { nom: string; review: number }[];
}

export async function loadShellCounts(): Promise<ShellCounts> {
  try {
    const { rows } = await query<{
      review: string;
      dead: string;
      en_attente: string;
      recent: string;
      lots: { nom: string; n: number }[] | null;
    }>(
      `select
         (select count(*) from scans where status = 'needs_review')::text as review,
         (select count(*) from jobs
           where status = 'dead' and created_at > now() - interval '24 hours')::text as dead,
         -- Des jobs prêts à être pris depuis plus de deux minutes…
         (select count(*) from jobs
           where status in ('queued','failed')
             and run_after < now() - interval '2 minutes')::text as en_attente,
         -- …et rien de terminé pendant ce temps : personne ne draine.
         (select count(*) from jobs
           where completed_at > now() - interval '2 minutes')::text as recent,
         -- Les lots qui ont encore des cartes à trier, pour la palette. DANS
         -- CETTE REQUÊTE : elle tourne sur chaque page, et un second
         -- aller-retour par page se paierait sur toute la session. Cinq
         -- suffisent — au-delà, la recherche par nom prend le relais.
         (select coalesce(json_agg(json_build_object('nom', x.nom, 'n', x.n)), '[]'::json)
            from (select ss.name as nom, count(*)::int as n, ss.opened_at
                    from scans s join sessions ss on ss.id = s.session_id
                   where s.status = 'needs_review'
                   group by ss.name, ss.opened_at
                   order by ss.opened_at desc
                   limit 5) x) as lots`,
    );
    const review = Number(rows[0]?.review ?? 0);
    const dead = Number(rows[0]?.dead ?? 0);
    const enAttente = Number(rows[0]?.en_attente ?? 0);
    const workerMuet = enAttente > 0 && Number(rows[0]?.recent ?? 0) === 0;

    return {
      review,
      enAttente,
      workerMuet,
      lots: (rows[0]?.lots ?? []).map((l) => ({ nom: l.nom, review: Number(l.n) })),
      // Un job mort ne se rejoue jamais tout seul : c'est une alarme, pas un
      // avertissement. Voir docs/05 §1.2.
      health: dead > 0 || workerMuet ? 'alarm' : review > 2400 ? 'warn' : 'ok',
    };
  } catch {
    return { review: 0, health: 'warn', workerMuet: false, enAttente: 0, lots: [] };
  }
}
