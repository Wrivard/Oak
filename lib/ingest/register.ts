import { withTransaction } from '../db.js';
import { log } from '../log.js';
import type { CardCondition, CardVariant } from '../sku.js';

/**
 * Enregistrement d'un scan, quelle que soit sa provenance.
 *
 * Deux chemins d'entrée existent maintenant :
 *   - le watcher sur dossier (`worker/ingest/watcher.ts`), pour un ADF qui
 *     dépose des fichiers ;
 *   - l'upload par navigateur (`/upload`), pour des photos déjà prises par une
 *     autre application.
 *
 * Les deux passent par ICI. Deux implémentations divergeraient sur le compteur
 * de session ou l'enfilement du job, et un scan qui n'enfile pas son
 * `fingerprint` disparaît en silence — le pire mode de défaillance du système.
 */
export interface RegisterInput {
  sessionId: string;
  seq: number;
  /** Chemin FINAL du fichier, celui qui restera lisible. */
  frontPath: string;
  backPath?: string | null;
}

export interface RegisterResult {
  scanId: string;
  /** false si la ligne existait déjà : le compteur n'a pas été incrémenté. */
  created: boolean;
}

export async function registerScan(input: RegisterInput): Promise<RegisterResult> {
  return withTransaction(async (client) => {
    const ins = await client.query<{ id: string; inserted: boolean }>(
      `insert into scans (session_id, seq, front_path, back_path)
       values ($1, $2, $3, $4)
       on conflict (session_id, seq) do update set front_path = excluded.front_path
       returning id, (xmax = 0) as inserted`,
      [input.sessionId, input.seq, input.frontPath, input.backPath ?? null],
    );
    const scan = ins.rows[0];
    if (!scan) throw new Error('insertion du scan impossible');

    // Le compteur ne bouge qu'à la création. Le sur-compter masquerait
    // précisément l'écart de comptage qu'on cherche à détecter (docs/02 §1).
    if (scan.inserted) {
      await client.query(
        `update sessions set scanned_count = scanned_count + 1 where id = $1`,
        [input.sessionId],
      );
    }

    // Enfilé DANS la transaction : un scan enregistré sans son job serait un
    // scan qui n'est jamais traité et que rien ne signale.
    await client.query(
      `insert into jobs (type, payload, idempotency_key)
       values ('fingerprint', $1, $2)
       on conflict (idempotency_key) do nothing`,
      [{ scan_id: scan.id }, `fingerprint:${scan.id}`],
    );

    return { scanId: scan.id, created: scan.inserted };
  });
}

/**
 * Prochain numéro d'ordre libre dans une session.
 *
 * L'upload n'a pas de compteur de feuilles comme un ADF : on prend la suite de
 * ce qui existe. La contrainte unique (session_id, seq) reste le garde-fou.
 */
export async function nextSeq(sessionId: string, client: {
  query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<number> {
  const { rows } = await client.query(
    'select coalesce(max(seq), 0) + 1 as next from scans where session_id = $1',
    [sessionId],
  );
  return Number((rows[0] as { next: string }).next);
}

export interface SessionDefaults {
  name: string;
  variant: CardVariant;
  condition: CardCondition;
  language: string;
}

/**
 * Ouvre une session, ou récupère celle qui porte ce nom.
 *
 * `default_variant` encode la décision de pré-tri physique du foil (docs/02 §2)
 * et vaut 5 à 20x d'écart de prix : c'est pour ça que l'upload la DEMANDE au
 * lieu de la deviner.
 */
export async function openSession(defaults: SessionDefaults): Promise<string> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      `select id from sessions where name = $1 and status = 'open'`,
      [defaults.name],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const created = await client.query<{ id: string }>(
      `insert into sessions (name, lane, default_variant, default_condition,
                             default_language)
       values ($1, 'upload', $2, $3, $4)
       returning id`,
      [defaults.name, defaults.variant, defaults.condition, defaults.language],
    );
    const id = created.rows[0]?.id;
    if (!id) throw new Error('création de session impossible');

    log.info('session ouverte', { name: defaults.name, variant: defaults.variant });
    return id;
  });
}
