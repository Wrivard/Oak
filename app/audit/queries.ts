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

export async function loadAudit(limit = 60, source?: string): Promise<AuditRow[]> {
  const { rows } = await query<Row>(
    `select s.id::text as scan_id, s.seq, ss.name as session_name,
            s.match_source::text, s.confidence::text,
            to_char(s.resolved_at, 'YYYY-MM-DD HH24:MI') as resolved_at,
            s.resolved_sku as sku,
            c.name as card_name, c.set_name, c.number, c.printed_total,
            c.image_small, s.ocr_read,
            (select count(*) from known_fingerprints k
              where k.source_scan = s.id)::text as fingerprints
       from scans s
       join sessions ss on ss.id = s.session_id
       join inventory i on i.sku = s.resolved_sku
       join cards c on c.id = i.card_id
      where s.status = 'resolved'
        -- Les résolutions MANUELLES n'ont pas à être auditées : c'est un humain
        -- qui les a faites, et les revoir ne ferait que du bruit.
        and s.match_source in ('catalog', 'own_history')
        and ($1::text is null or s.match_source::text = $1)
      order by s.resolved_at desc
      limit $2`,
    [source ?? null, limit],
  );

  return rows.map((r) => ({
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
}
