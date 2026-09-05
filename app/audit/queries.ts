import { query } from '../../lib/db.js';

/**
 * Audit des résolutions automatiques.
 *
 * Le système résout seul une bonne part des cartes. Sans cet écran, on lui fait
 * confiance à l'aveugle — et une erreur ne se découvre qu'à la commande qu'on ne
 * peut pas honorer.
 *
 * Le mécanisme d'apprentissage rend l'erreur PIRE que ponctuelle : une mauvaise
 * résolution écrit une empreinte fausse, et toutes les occurrences suivantes de
 * cette carte hériteront de la même erreur par le niveau 1.
 */
export interface AuditRow {
  scanId: string;
  seq: number;
  sessionName: string;
  source: string;
  confidence: string | null;
  resolvedAt: string;
  sku: string;
  cardName: string;
  setName: string;
  number: string;
  printedTotal: number | null;
  cardImage: string | null;
  ocrRead: string | null;
  /** Nombre d'empreintes que cette résolution a produites. */
  fingerprints: number;
}

interface Row {
  scan_id: string;
  seq: number;
  session_name: string;
  match_source: string;
  confidence: string | null;
  resolved_at: string;
  sku: string;
  card_name: string;
  set_name: string;
  number: string;
  printed_total: number | null;
  image_small: string | null;
  ocr_read: string | null;
  fingerprints: string;
}

export const AUDIT_PAGE_SIZE = 60;

export type AuditSort = 'recent' | 'doubtful';

/**
 * `doubtful` d'abord : c'est la stratégie d'audit qui attrape le plus d'erreurs.
 *
 * Regarder les soixante plus RÉCENTES sur les huit cents d'une journée, c'est
 * regarder 7 % du lot au hasard. Regarder les soixante MOINS SÛRES, c'est
 * regarder celles où la machine a le plus de chances de s'être trompée.
 *
 * Réserve : la confiance de `own_history` vient d'une distance de Hamming et
 * celle de `catalog` d'une distance cosinus — deux échelles différentes. Trier
 * sur les deux à la fois mélange donc des chiffres qui ne se comparent pas ; le
 * tri est le plus utile combiné à un filtre de source.
 */
const AUDIT_ORDER: Record<AuditSort, string> = {
  recent: 's.resolved_at desc',
  doubtful: 's.confidence asc nulls first, s.resolved_at desc',
};

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  page: number;
  pages: number;
}

export async function loadAudit(
  params: { page?: number; source?: string; sort?: AuditSort } = {},
): Promise<AuditPage> {
  const page = Math.max(1, params.page ?? 1);
  const sort: AuditSort = params.sort === 'doubtful' ? 'doubtful' : 'recent';
  const source = params.source;

  const { rows } = await query<Row & { total: string }>(
    `select s.id::text as scan_id, s.seq, ss.name as session_name,
            s.match_source::text, s.confidence::text,
            to_char(s.resolved_at, 'YYYY-MM-DD HH24:MI') as resolved_at,
            s.resolved_sku as sku,
            c.name as card_name, c.set_name, c.number, c.printed_total,
            c.image_small, s.ocr_read,
            (select count(*) from known_fingerprints k
              where k.source_scan = s.id)::text as fingerprints,
            count(*) over ()::text as total
       from scans s
       join sessions ss on ss.id = s.session_id
       join inventory i on i.sku = s.resolved_sku
       join cards c on c.id = i.card_id
      where s.status = 'resolved'
        -- Les résolutions manuelles sont HORS de la vue par défaut : elles sont
        -- majoritaires au début, et les faire défiler noierait celles que la
        -- machine a décidées seule — qui sont l'objet de cet écran.
        --
        -- Mais elles restent atteignables par ?source=manual. Un humain se
        -- trompe aussi, et une erreur manuelle est même PIRE : confirmed_by =
        -- 'manual' fait autorité, et l'empreinte fausse se propage au niveau 1
        -- sans jamais repasser par le catalogue. Sans ce filtre, il n'existait
        -- aucun chemin pour la retrouver et la corriger.
        and ($1::text is null
             or s.match_source::text = $1)
        and ($1::text is not null
             or s.match_source in ('catalog', 'own_history'))
      order by ${AUDIT_ORDER[sort]}
      limit $2 offset $3`,
    [source ?? null, AUDIT_PAGE_SIZE, (page - 1) * AUDIT_PAGE_SIZE],
  );

  const total = Number(rows[0]?.total ?? 0);

  const mapped = rows.map((r) => ({
    scanId: r.scan_id,
    seq: r.seq,
    sessionName: r.session_name,
    source: r.match_source,
    confidence: r.confidence,
    resolvedAt: r.resolved_at,
    sku: r.sku,
    cardName: r.card_name,
    setName: r.set_name,
    number: r.number,
    printedTotal: r.printed_total,
    cardImage: r.image_small,
    ocrRead: r.ocr_read,
    fingerprints: Number(r.fingerprints),
  }));

  return {
    rows: mapped,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
  };
}
