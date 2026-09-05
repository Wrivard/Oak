import { query } from '../../lib/db.js';

/**
 * Les cinq métriques de docs/05-production.md §1.2.
 *
 * Une seule page. Si elle est verte, on peut aller dormir.
 */
export type Health = 'ok' | 'warn' | 'alarm';

export interface Metric {
  label: string;
  value: string;
  detail: string;
  health: Health;
  /** Le seuil qui déclenche l'alarme, affiché pour qu'il ne soit pas mystérieux. */
  threshold: string;
}

/** Capacité de review estimée par jour, à 3 s par carte sur 2 h de travail. */
const DAILY_REVIEW_CAPACITY = 2400;

/** Le taux de review manuelle est LA métrique économique du projet. */
const MANUAL_RATE_ALARM = 0.15;
const QUEUE_DEPTH_ALARM = 5000;

export async function loadMetrics(): Promise<Metric[]> {
  const [worker, resolution, queue, dead, review, reconcile] = await Promise.all([
    workerAlive(),
    resolutionMix(),
    queueDepth(),
    deadJobs(),
    needsReview(),
    reconciliationGap(),
  ]);
  // Le worker en premier : si lui ne tourne pas, les cinq autres métriques
  // décrivent un système figé et n'apprennent rien.
  return [worker, resolution, queue, dead, review, reconcile];
}

/**
 * Le worker draine-t-il ?
 *
 * Ce n'est pas dans les cinq métriques du doc, mais c'est la panne la plus
 * probable en exploitation réelle : on ferme la fenêtre sans y penser et plus
 * rien n'avance, sans aucun signal.
 */
async function workerAlive(): Promise<Metric> {
  const { rows } = await query<{ attente: string; recent: string; dernier: string | null }>(
    `select
       (select count(*) from jobs
         where status in ('queued','failed')
           and run_after < now() - interval '2 minutes')::text as attente,
       (select count(*) from jobs
         where completed_at > now() - interval '2 minutes')::text as recent,
       (select to_char(max(completed_at), 'HH24:MI:SS') from jobs)::text as dernier`,
  );

  const attente = Number(rows[0]?.attente ?? 0);
  const recent = Number(rows[0]?.recent ?? 0);
  const muet = attente > 0 && recent === 0;

  return {
    label: 'Worker',
    value: muet ? 'arrêté' : recent > 0 ? 'actif' : 'au repos',
    detail: muet
      ? `${attente} job${attente > 1 ? 's' : ''} en attente, rien de terminé depuis 2 min`
      : `dernier job terminé à ${rows[0]?.dernier ?? '—'}`,
    health: muet ? 'alarm' : 'ok',
    threshold: 'des jobs attendent et rien n’avance',
  };
}

/**
 * Répartition own_history / catalog / manual sur 7 jours glissants.
 *
 * La part `manual` devrait descendre avec le temps, jamais monter : c'est le
 * seul coût marginal par carte qui reste, et il se paie en minutes.
 */
async function resolutionMix(): Promise<Metric> {
  const { rows } = await query<{ match_source: string | null; n: string }>(
    `select match_source, count(*)::text as n
       from scans
      where created_at > now() - interval '7 days'
        and status in ('resolved','needs_review')
      group by 1`,
  );

  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  if (total === 0) {
    return {
      label: 'Résolution par niveau (7 j)',
      value: '—',
      detail: 'aucun scan sur la période',
      health: 'ok',
      threshold: `manual > ${MANUAL_RATE_ALARM * 100} %`,
    };
  }

  const by = (src: string | null) =>
    Number(rows.find((r) => r.match_source === src)?.n ?? 0);

  const own = by('own_history');
  const cat = by('catalog');
  const man = by('manual');
  // Un scan en needs_review non encore traité n'a pas de match_source : il
  // compte comme du manuel, puisque c'est ce qu'il va coûter.
  const pending = by(null);
  const manualRate = (man + pending) / total;

  return {
    label: 'Résolution par niveau (7 j)',
    value: `${Math.round(manualRate * 100)} % manuel`,
    detail: `own_history ${own} · catalog ${cat} · manuel ${man + pending} · total ${total}`,
    health: manualRate > MANUAL_RATE_ALARM ? 'alarm' : manualRate > 0.1 ? 'warn' : 'ok',
    threshold: `manual > ${MANUAL_RATE_ALARM * 100} %`,
  };
}

async function queueDepth(): Promise<Metric> {
  const { rows } = await query<{ type: string; n: string }>(
    `select type, count(*)::text as n
       from jobs where status in ('queued','failed')
      group by 1 order by 2 desc`,
  );
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const worst = rows[0];

  return {
    label: 'Profondeur de file',
    value: String(total),
    detail:
      rows.length === 0
        ? 'file vide'
        : rows.map((r) => `${r.type} ${r.n}`).join(' · '),
    health:
      Number(worst?.n ?? 0) > QUEUE_DEPTH_ALARM
        ? 'alarm'
        : total > QUEUE_DEPTH_ALARM / 2
          ? 'warn'
          : 'ok',
    threshold: `> ${QUEUE_DEPTH_ALARM} sur un type`,
  };
}

/** Un job mort n'est jamais rejoué automatiquement : zéro est le seul état sain. */
async function deadJobs(): Promise<Metric> {
  const { rows } = await query<{ n: string; types: string | null }>(
    `select count(*)::text as n, string_agg(distinct type, ', ') as types
       from jobs
      where status = 'dead' and created_at > now() - interval '24 hours'`,
  );
  const n = Number(rows[0]?.n ?? 0);

  return {
    label: 'Jobs morts (24 h)',
    value: String(n),
    detail: n === 0 ? 'aucun' : (rows[0]?.types ?? ''),
    health: n > 0 ? 'alarm' : 'ok',
    threshold: '> 0',
  };
}

async function needsReview(): Promise<Metric> {
  const { rows } = await query<{ n: string; plus_vieux: string | null }>(
    `select count(*)::text as n,
            to_char(min(created_at), 'YYYY-MM-DD HH24:MI') as plus_vieux
       from scans where status = 'needs_review'`,
  );
  const n = Number(rows[0]?.n ?? 0);

  return {
    label: 'Cartes en review',
    value: String(n),
    detail:
      n === 0
        ? 'file vide'
        : `plus ancienne : ${rows[0]?.plus_vieux ?? '?'} · capacité ~${DAILY_REVIEW_CAPACITY}/j`,
    health: n > DAILY_REVIEW_CAPACITY ? 'alarm' : n > DAILY_REVIEW_CAPACITY / 2 ? 'warn' : 'ok',
    threshold: `> capacité quotidienne (~${DAILY_REVIEW_CAPACITY})`,
  };
}

/**
 * Écart de réconciliation.
 *
 * Deux écarts distincts, et le second est le pire bug possible du système parce
 * qu'il est SILENCIEUX : une double-alimentation du scanner fait exister une
 * carte physique sans ligne d'inventaire. On ne la vend pas, on ne la retrouve
 * jamais (docs/02 §1).
 */
async function reconciliationGap(): Promise<Metric> {
  const { rows } = await query<{ name: string; expected: number; scanned: number }>(
    `select name, expected_count as expected, scanned_count as scanned
       from sessions
      where status = 'open' and expected_count is not null
        and expected_count <> scanned_count`,
  );

  return {
    label: 'Écart de comptage de session',
    value: String(rows.length),
    detail:
      rows.length === 0
        ? 'toutes les sessions balancent'
        : rows
            .map((r) => `${r.name} : ${r.scanned}/${r.expected}`)
            .join(' · '),
    health: rows.length > 0 ? 'alarm' : 'ok',
    threshold: '> 0 session en écart',
  };
}
