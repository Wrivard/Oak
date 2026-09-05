import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
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

/**
 * Concurrence d'ingestion.
 *
 * MESURÉ, pas choisi au hasard : en fire-and-forget non borné, déposer 2 000
 * fichiers d'un coup lance 2 000 transactions simultanées contre un pool de 10
 * connexions. 1 849 d'entre elles ont expiré sur « timeout exceeded when trying
 * to connect » et les fichiers ont été ABANDONNÉS EN SILENCE dans l'inbox — le
 * pire mode de défaillance possible pour ce système, celui d'une carte physique
 * sans ligne d'inventaire. Le worker lui-même s'est retrouvé affamé de
 * connexions et n'arrivait plus à réclamer ses jobs.
 *
 * Un ADF à 60 pages/minute produit exactement ce genre de rafale.
 */
const INGEST_CONCURRENCY = 4;
const MAX_INGEST_ATTEMPTS = 3;

/**
 * File d'ingestion bornée.
 *
 * Le débit n'est pas perdu : la base est de toute façon le goulot, et la
 * sérialiser proprement est plus rapide que de la saturer puis d'échouer.
 */
class IngestQueue {
  private readonly pending: { file: string; attempts: number }[] = [];
  private active = 0;

  constructor(private readonly opts: WatcherOptions) {}

  push(file: string): void {
    this.pending.push({ file, attempts: 0 });
    this.pump();
  }

  private pump(): void {
    while (this.active < INGEST_CONCURRENCY && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) return;
      this.active += 1;

      void ingestFile(item.file, this.opts)
        .catch((err: unknown) => {
          item.attempts += 1;
          if (item.attempts < MAX_INGEST_ATTEMPTS) {
            // Transitoire jusqu'à preuve du contraire : on remet en file plutôt
            // que d'abandonner le fichier là où personne ne le reverra.
            log.warn('ingestion en échec, nouvelle tentative', {
              file: basename(item.file),
              tentative: item.attempts,
              err,
            });
            this.pending.push(item);
            return;
          }
          // Épuisé : le fichier part en rejet, VISIBLE, jamais supprimé.
          log.error('ingestion abandonnée après plusieurs tentatives', {
            file: basename(item.file),
            tentatives: item.attempts,
            err,
          });
          void moveTo(this.opts.rejected, '_echec_ingestion', item.file).catch(
            (e: unknown) =>
              log.error('déplacement en rejet impossible', {
                file: basename(item.file),
                err: e,
              }),
          );
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  get depth(): number {
    return this.pending.length + this.active;
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

  const queue = new IngestQueue(opts);
  watcher.on('add', (file: string) => queue.push(file));

  watcher.on('error', (err: unknown) => log.error('watcher en erreur', { err }));
  log.info('watcher démarré', { inbox: opts.inbox });
  return watcher;
}
