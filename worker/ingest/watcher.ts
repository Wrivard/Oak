import { mkdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { log } from '../../lib/log.js';
import { withTransaction } from '../../lib/db.js';
import { enqueue } from '../queue/queue.js';
import { parseName, type ParsedName } from './filename.js';

/**
 * Le watcher fait trois choses et rien d'autre : parse le nom, insère une ligne
 * `scans`, enqueue un job `fingerprint`. Puis il déplace le fichier vers
 * `processed/{session}/`. AUCUN traitement d'image ici.
 *
 * Voir docs/02-ingest-and-matching.md §1.
 */
export interface WatcherOptions {
  inbox: string;
  processed: string;
  /** Fichiers illisibles ou de session inconnue. Jamais supprimés. */
  rejected: string;
}

/**
 * Versos arrivés avant leur recto. L'ADF écrit normalement recto puis verso,
 * mais chokidar ne garantit pas l'ordre. `front_path` est NOT NULL, donc on ne
 * peut pas créer la ligne depuis un verso : on le garde de côté.
 */
const orphanBacks = new Map<string, string>();

const key = (p: ParsedName): string => `${p.session}:${p.seq}`;

/** Chemin final d'un fichier une fois classé. Calculé AVANT l'insertion. */
function destination(dir: string, session: string, file: string): string {
  return join(dir, session, basename(file));
}

async function moveTo(dir: string, session: string, file: string): Promise<void> {
  const target = join(dir, session);
  await mkdir(target, { recursive: true });
  await rename(file, join(target, basename(file)));
}

/**
 * Résout le nom de session en UUID. Ne crée JAMAIS la session :
 * `sessions.default_variant` encode la décision de pré-tri physique du foil
 * (docs/02 §2), et la deviner mal étiquetterait un lot entier — c'est l'erreur
 * la plus coûteuse du système. Une session inconnue est un rejet.
 */
async function resolveSession(
  client: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> },
  name: string,
): Promise<string | null> {
  const { rows } = await client.query(
    `select id from sessions where name = $1 and status = 'open'`,
    [name],
  );
  return (rows[0] as { id: string } | undefined)?.id ?? null;
}

export async function ingestFile(file: string, opts: WatcherOptions): Promise<void> {
  const name = basename(file);
  const parsed = parseName(name);

  if (!parsed) {
    log.warn('nom de fichier non conforme, rejeté', { file: name });
    await moveTo(opts.rejected, '_unparsed', file);
    return;
  }

  const pending = orphanBacks.get(key(parsed));

  // Les chemins écrits en base sont les chemins FINAUX, pas ceux de l'inbox.
  // Le watcher déplace le fichier juste après : enregistrer le chemin d'inbox
  // donnerait une ligne qui pointe sur un fichier disparu, et le handler
  // fingerprint échouerait sur chaque scan.
  const finalFront = destination(opts.processed, parsed.session, file);
  const finalBack =
    parsed.side === 'back'
      ? destination(opts.processed, parsed.session, file)
      : pending
        ? destination(opts.processed, parsed.session, pending)
        : null;

  const outcome = await withTransaction(async (client) => {
    const sessionId = await resolveSession(client, parsed.session);
    if (sessionId === null) return { kind: 'unknown-session' as const };

    if (parsed.side === 'back') {
      const upd = await client.query(
        `update scans set back_path = $3
          where session_id = $1 and seq = $2`,
        [sessionId, parsed.seq, finalBack],
      );
      if (upd.rowCount === 0) return { kind: 'orphan-back' as const };
      return { kind: 'back-attached' as const, sessionId };
    }

    // Recto : crée la ligne. La contrainte unique (session_id, seq) rend le
    // rattrapage au redémarrage idempotent gratuitement — un fichier revu deux
    // fois ne crée pas de doublon.
    const ins = await client.query<{ id: string; inserted: boolean }>(
      `insert into scans (session_id, seq, front_path, back_path)
       values ($1, $2, $3, $4)
       on conflict (session_id, seq) do update set front_path = excluded.front_path
       returning id, (xmax = 0) as inserted`,
      [sessionId, parsed.seq, finalFront, finalBack],
    );
    const scan = ins.rows[0];
    if (!scan) throw new Error(`insertion du scan impossible: ${name}`);

    // Compteur de session : c'est lui qu'on réconcilie contre expected_count
    // pour attraper les double-feed silencieuses (docs/02 §1).
    if (scan.inserted) {
      await client.query(
        `update sessions set scanned_count = scanned_count + 1 where id = $1`,
        [sessionId],
      );
    }

    await enqueue(
      'fingerprint',
      { scan_id: scan.id },
      { idempotencyKey: `fingerprint:${scan.id}`, client },
    );

    return { kind: 'front-ingested' as const, sessionId, scanId: scan.id };
  });

  switch (outcome.kind) {
    case 'unknown-session':
      log.warn('session inconnue ou fermée, fichier rejeté', {
        file: name,
        session: parsed.session,
      });
      await moveTo(opts.rejected, parsed.session, file);
      return;

    case 'orphan-back':
      // Le recto n'est pas encore arrivé. On garde le fichier en place et on
      // rattachera au moment de son insertion.
      orphanBacks.set(key(parsed), file);
      log.debug('verso avant recto, mis de côté', { file: name });
      return;

    case 'back-attached':
      orphanBacks.delete(key(parsed));
      await moveTo(opts.processed, parsed.session, file);
      return;

    case 'front-ingested':
      if (pending) {
        orphanBacks.delete(key(parsed));
        await moveTo(opts.processed, parsed.session, pending);
      }
      await moveTo(opts.processed, parsed.session, file);
      log.info('scan ingéré', {
        scan_id: outcome.scanId,
        session: parsed.session,
        seq: parsed.seq,
      });
      return;
  }
}

export function startWatcher(opts: WatcherOptions): FSWatcher {
  const watcher = watch(opts.inbox, {
    // Le scanner écrit progressivement : attendre la stabilité du fichier.
    awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
    // false : reprend les fichiers laissés par un crash.
    ignoreInitial: false,
    depth: 0,
  });

  watcher.on('add', (file: string) => {
    void ingestFile(file, opts).catch((err: unknown) => {
      log.error('ingestion échouée', { file: basename(file), dir: dirname(file), err });
    });
  });

  watcher.on('error', (err: unknown) => log.error('watcher en erreur', { err }));
  log.info('watcher démarré', { inbox: opts.inbox });
  return watcher;
}
