import { query } from '../../lib/db.js';

/**
 * Suivi des lots. Sans cet écran, on envoie des photos et on ne sait pas ce
 * qu'elles deviennent : combien sont résolues, combien attendent une review,
 * si l'appariement recto/verso a signalé quelque chose.
 */
export interface Batch {
  id: string;
  name: string;
  lane: string;
  variant: string;
  condition: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  expected: number | null;
  scanned: number;
  /** Répartition des scans. */
  pending: number;
  review: number;
  resolved: number;
  /** Pages écartées : pas des cartes (intercalaire, page blanche). */
  rejected: number;
  ownHistory: number;
  catalog: number;
  manual: number;
  /** Anomalies d'appariement relevées à l'ingestion. */
  anomalies: number;
  /**
   * La carte la plus chère du lot, et ce que le lot vaut.
   *
   * Une ligne de tableau nommée `bulk-vintage` ne dit rien de ce qu'il y a
   * dedans. Une image et un montant, si — et c'est ce qui décide dans quel
   * ordre on traite ses lots un dimanche soir.
   *
   * Absents quand rien n'est encore résolu : on ne montre pas une vignette au
   * hasard ni un total qui ne compte qu'un tiers des cartes sans le dire.
   */
  image: string | null;
  valeurCents: number | null;
}

interface Row {
  id: string;
  name: string;
  lane: string;
  variant: string;
  condition: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  expected_count: number | null;
  scanned_count: number;
  pending: string;
  review: string;
  resolved: string;
  rejected: string;
  own_history: string;
  catalog: string;
  manual: string;
  anomalies: string;
  image: string | null;
  valeur: string | null;
}

/**
 * @param vedette  Joindre la carte la plus chère et le total du lot.
 *
 * Mesuré : +45 ms sur cinq sessions, deux `lateral` de plus. C'est le prix de
 * l'écran des lots, pas celui du bandeau de quatre lignes de l'écran d'envoi —
 * qui se rafraîchit toutes les douze secondes après un envoi et n'affiche
 * aucune image.
 */
export interface BatchFiltre {
  /** Sous-chaîne du nom du lot. Insensible à la casse et aux accents. */
  recherche?: string | undefined;
  /** `open`, `closed`, ou rien pour les deux. */
  statut?: 'open' | 'closed' | undefined;
}

export async function loadBatches(
  limit = 40,
  vedette = false,
  filtre: BatchFiltre = {},
): Promise<Batch[]> {
  const recherche = (filtre.recherche ?? '').trim();
  const { rows } = await query<Row>(
    `select ss.id, ss.name, ss.lane, ss.default_variant::text as variant,
            ss.default_condition::text as condition, ss.status,
            to_char(ss.opened_at, 'YYYY-MM-DD HH24:MI') as opened_at,
            to_char(ss.closed_at, 'YYYY-MM-DD HH24:MI') as closed_at,
            ss.expected_count, ss.scanned_count,
            count(s.*) filter (where s.status in ('pending','fingerprinted','matched'))::text as pending,
            count(s.*) filter (where s.status = 'needs_review')::text as review,
            count(s.*) filter (where s.status = 'resolved')::text as resolved,
            count(s.*) filter (where s.status = 'rejected')::text as rejected,
            count(s.*) filter (where s.match_source = 'own_history')::text as own_history,
            count(s.*) filter (where s.match_source = 'catalog')::text as catalog,
            count(s.*) filter (where s.match_source = 'manual')::text as manual,
            coalesce(a.n, 0)::text as anomalies,
            ${vedette ? 'v.image_small' : 'null::text'} as image,
            ${vedette ? 'somme.total::text' : 'null::text'} as valeur
       from sessions ss
       left join scans s on s.session_id = ss.id
       -- Agrégé UNE fois plutôt qu'une sous-requête corrélée par session.
       -- À 326 lignes la différence est invisible ; à plusieurs centaines de
       -- milliers, la version corrélée devient O(sessions x événements).
       left join (
         select payload->>'session_id' as sid, count(*) as n
           from channel_events
          where event = 'upload_anomalies'
          group by 1
       ) a on a.sid = ss.id::text
       ${
         vedette
           ? `left join lateral (
                select c.image_small
                  from scans s2
                  join inventory i on i.sku = s2.resolved_sku
                  join cards c on c.id = i.card_id
                 where s2.session_id = ss.id
                   and s2.status = 'resolved'
                   and c.image_small is not null
                 order by i.value_estimate desc nulls last
                 limit 1
              ) v on true
              left join lateral (
                select sum(i.value_estimate) as total
                  from scans s3
                  join inventory i on i.sku = s3.resolved_sku
                 where s3.session_id = ss.id and s3.status = 'resolved'
              ) somme on true`
           : ''
       }
      where ($2 = '' or ss.name ilike '%' || $2 || '%')
        and ($3::text is null or ss.status::text = $3)
      group by ss.id, a.n${vedette ? ', v.image_small, somme.total' : ''}
      order by ss.opened_at desc
      limit $1`,
    [limit, recherche, filtre.statut ?? null],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    lane: r.lane,
    variant: r.variant,
    condition: r.condition,
    status: r.status,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    expected: r.expected_count,
    scanned: r.scanned_count,
    pending: Number(r.pending),
    review: Number(r.review),
    resolved: Number(r.resolved),
    rejected: Number(r.rejected),
    ownHistory: Number(r.own_history),
    catalog: Number(r.catalog),
    manual: Number(r.manual),
    anomalies: Number(r.anomalies),
    image: r.image,
    // Le total est en dollars en base ; l'application compte en cents entiers.
    valeurCents:
      r.valeur === null ? null : Math.round(Number(r.valeur) * 100),
  }));
}

export interface AnomalyDetail {
  sessionName: string;
  reason: string;
  at: string;
}

/**
 * Les anomalies d'appariement, en clair.
 *
 * Un lot décalé d'une page fait grader la mauvaise carte : ce n'est pas une
 * information qu'on laisse dormir dans une colonne jsonb.
 */
export async function loadAnomalies(limit = 20): Promise<AnomalyDetail[]> {
  const { rows } = await query<{ name: string; reason: string; at: string }>(
    `select ss.name,
            a->>'reason' as reason,
            to_char(ce.created_at, 'YYYY-MM-DD HH24:MI') as at
       from channel_events ce
       join sessions ss on ss.id::text = ce.payload->>'session_id'
       cross join lateral jsonb_array_elements(ce.payload->'anomalies') a
      where ce.event = 'upload_anomalies'
      order by ce.created_at desc
      limit $1`,
    [limit],
  );
  return rows.map((r) => ({ sessionName: r.name, reason: r.reason, at: r.at }));
}
