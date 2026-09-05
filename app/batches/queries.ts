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
}

export async function loadBatches(limit = 40): Promise<Batch[]> {
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
            coalesce(a.n, 0)::text as anomalies
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
      group by ss.id, a.n
      order by ss.opened_at desc
      limit $1`,
    [limit],
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
