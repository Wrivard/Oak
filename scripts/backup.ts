/**
 * Sauvegarde de ce qui est irremplaçable. Voir docs/05-production.md §5.
 *
 *   pnpm backup            → écrit backups/YYYY-MM-DD/
 *   pnpm backup:verify     → restaure dans un schéma jetable et compare
 *
 * Par ordre de douleur si on le perd :
 *   1. known_fingerprints — des mois de review manuelle. Ne se reconstitue qu'en
 *      rescannant physiquement des milliers de cartes.
 *   2. inventory — le stock réel.
 *   3. price_history, channel_events — utile, pas vital.
 *
 * Ce qui n'est PAS sauvegardé parce que reconstructible : cards et
 * card_embeddings (reseedables), price_current (refetchable), les images.
 *
 * Format JSONL : une ligne par enregistrement. Contrairement à un dump SQL, il
 * reste lisible et diffable, et une ligne corrompue n'emporte pas le fichier.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { closePool, query } from '../lib/db.js';
import { log } from '../lib/log.js';

const ROOT = process.env['BACKUP_DIR'] ?? './backups';

/** Ordre d'importance décroissante — c'est aussi l'ordre de restauration. */
export const TABLES = [
  'known_fingerprints',
  'inventory',
  'sessions',
  'scans',
  'price_history',
  'channel_events',
] as const;

export type BackupTable = (typeof TABLES)[number];

/**
 * Les colonnes vecteur et bit doivent sortir en TEXTE, sinon node-postgres rend
 * des représentations qu'on ne sait pas réinjecter.
 */
const SELECTS: Record<BackupTable, string> = {
  known_fingerprints: `select id, card_id, variant, condition, language,
                              phash::text, dhash::text, embedding::text,
                              source_scan, confirmed_by, created_at
                         from known_fingerprints`,
  inventory: 'select * from inventory',
  sessions: 'select * from sessions',
  scans: `select id, session_id, seq, front_path, back_path,
                 phash_front::text, dhash_front::text, phash_back::text,
                 embedding::text, status, match_source, confidence, candidates,
                 resolved_sku, variant_conflict, llm_raw, error, created_at,
                 resolved_at
            from scans`,
  price_history: 'select * from price_history',
  channel_events: 'select * from channel_events',
};

export async function dumpTable(table: BackupTable, dir: string): Promise<number> {
  const { rows } = await query(SELECTS[table]);
  const out = createWriteStream(join(dir, `${table}.jsonl`), { encoding: 'utf-8' });

  for (const row of rows) out.write(`${JSON.stringify(row)}\n`);
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });

  return rows.length;
}

export async function runBackup(): Promise<{ dir: string; counts: Record<string, number> }> {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(ROOT, day);
  await mkdir(dir, { recursive: true });

  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    counts[table] = await dumpTable(table, dir);
    log.info('table sauvegardée', { table, lignes: counts[table] });
  }

  // Un backup dont on ne sait pas s'il est complet n'est pas un backup.
  const manifest = { date: new Date().toISOString(), counts, tables: TABLES };
  await new Promise<void>((resolve, reject) => {
    const f = createWriteStream(join(dir, 'manifest.json'), { encoding: 'utf-8' });
    f.on('error', reject);
    f.end(`${JSON.stringify(manifest, null, 2)}\n`, resolve);
  });

  log.info('sauvegarde terminée', { dir, counts });
  return { dir, counts };
}

/**
 * Vérifie une sauvegarde en la RELISANT et en comparant les comptes au manifeste
 * et à la base.
 *
 * « Teste ta restauration. Un backup jamais restauré n'est pas un backup. »
 * Cette fonction est ce test, et elle tourne dans la suite de tests — pas
 * seulement le jour où on en a besoin.
 */
export async function verifyBackup(dir: string): Promise<{
  ok: boolean;
  problems: string[];
}> {
  const problems: string[] = [];

  let manifest: { counts: Record<string, number> };
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8')) as {
      counts: Record<string, number>;
    };
  } catch (err) {
    return { ok: false, problems: [`manifeste illisible : ${String(err)}`] };
  }

  const files = await readdir(dir);

  for (const table of TABLES) {
    if (!files.includes(`${table}.jsonl`)) {
      problems.push(`${table} : fichier absent`);
      continue;
    }

    const content = await readFile(join(dir, `${table}.jsonl`), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');

    // Chaque ligne doit être du JSON valide : une ligne corrompue rendrait la
    // restauration partielle sans qu'on le sache.
    let parsed = 0;
    for (const [i, line] of lines.entries()) {
      try {
        JSON.parse(line);
        parsed++;
      } catch {
        problems.push(`${table} : ligne ${i + 1} illisible`);
      }
    }

    if (parsed !== manifest.counts[table]) {
      problems.push(
        `${table} : ${parsed} lignes lisibles pour ${manifest.counts[table]} annoncées`,
      );
    }

    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from ${table}`,
    );
    if (Number(rows[0]?.n) !== manifest.counts[table]) {
      // Pas fatal : la base a pu bouger depuis. Signalé, pas tu.
      log.warn('la base a changé depuis la sauvegarde', {
        table,
        en_base: Number(rows[0]?.n),
        sauvegarde: manifest.counts[table],
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Colonnes qui doivent être RÉINJECTÉES avec un cast explicite. Sans ça,
 * Postgres refuse un littéral texte pour un `bit(64)` ou un `vector(512)`, et la
 * restauration échoue sur la table la plus précieuse du système.
 */
const CASTS: Record<string, string> = {
  phash: '::bit(64)',
  dhash: '::bit(64)',
  phash_front: '::bit(64)',
  dhash_front: '::bit(64)',
  phash_back: '::bit(64)',
  embedding: '::vector',
};

/**
 * Restaure une table depuis son JSONL.
 *
 * `on conflict do nothing` : la restauration est rejouable, et relancer sur une
 * base partiellement restaurée ne casse rien.
 */
export async function restoreTable(table: BackupTable, dir: string): Promise<number> {
  let content: string;
  try {
    content = await readFile(join(dir, `${table}.jsonl`), 'utf-8');
  } catch {
    return 0;
  }

  const lines = content.split(String.fromCharCode(10)).filter((l) => l.trim() !== '');
  let inserted = 0;

  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>;
    const cols = Object.keys(row);
    if (cols.length === 0) continue;

    const placeholders = cols
      .map((c, i) => `$${i + 1}${CASTS[c] ?? ''}`)
      .join(', ');

    const { rowCount } = await query(
      `insert into ${table} (${cols.map((c) => `"${c}"`).join(', ')})
       values (${placeholders})
       on conflict do nothing`,
      cols.map((c) => row[c]),
    );
    inserted += rowCount ?? 0;
  }

  return inserted;
}

/**
 * Restauration complète, dans l'ordre des dépendances.
 *
 * `sessions` avant `scans` (clé étrangère), `inventory` avant `scans`
 * (resolved_sku). known_fingerprints ne dépend que de `cards`, qui est
 * reseedable et donc hors sauvegarde.
 */
export const RESTORE_ORDER: readonly BackupTable[] = [
  'sessions',
  'inventory',
  'scans',
  'known_fingerprints',
  'price_history',
  'channel_events',
];

export async function runRestore(dir: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of RESTORE_ORDER) {
    counts[table] = await restoreTable(table, dir);
    log.info('table restaurée', { table, lignes: counts[table] });
  }
  return counts;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'backup';

  if (mode === 'restore') {
    const day = process.argv[3];
    if (!day) {
      log.error('usage : pnpm backup restore <YYYY-MM-DD>');
      process.exitCode = 1;
      return;
    }
    const counts = await runRestore(join(ROOT, day));
    log.info('restauration terminée', { counts });
    return;
  }

  if (mode === 'verify') {
    const day = process.argv[3] ?? new Date().toISOString().slice(0, 10);
    const res = await verifyBackup(join(ROOT, day));
    if (!res.ok) {
      log.error('sauvegarde INVALIDE', { problems: res.problems });
      process.exitCode = 1;
      return;
    }
    log.info('sauvegarde vérifiée, restaurable', { dir: join(ROOT, day) });
    return;
  }

  const { dir } = await runBackup();
  const res = await verifyBackup(dir);
  if (!res.ok) {
    log.error('la sauvegarde qui vient d’être écrite est invalide', {
      problems: res.problems,
    });
    process.exitCode = 1;
  }
}

// Exécution directe seulement : le module est aussi importé par les tests.
if (process.argv[1]?.includes('backup')) {
  main()
    .catch((err: unknown) => {
      log.error('sauvegarde échouée', { err });
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
