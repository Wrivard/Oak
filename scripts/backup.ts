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

/**
 * Clé de pagination par table. Toujours la clé primaire : elle est unique et
 * indexée, donc la pagination par curseur est stable et ne saute rien même si
 * des lignes sont insérées pendant la sauvegarde.
 */
const CLE: Record<BackupTable, string> = {
  known_fingerprints: 'id',
  inventory: 'sku',
  sessions: 'id',
  scans: 'id',
  price_history: 'id',
  channel_events: 'id',
};

/** Lignes par tranche. Voir dumpTable pour pourquoi ce n'est pas « toutes ». */
const TRANCHE = 2000;

export async function dumpTable(table: BackupTable, dir: string): Promise<number> {
  const out = createWriteStream(join(dir, `${table}.jsonl`), { encoding: 'utf-8' });
  const cle = CLE[table];
  let curseur: string | null = null;
  let total = 0;
  type Ligne = Record<string, unknown>;

  // PAR TRANCHES, pas d'un coup. `select * from scans` charge la table entière
  // en mémoire : à 200 000 scans dont chacun porte un embedding sérialisé en
  // texte (512 flottants, ~8 Ko), ça fait plus d'un gigaoctet de tampon avant
  // la première ligne écrite. La sauvegarde tomberait précisément le jour où
  // elle devient indispensable.
  //
  // Pagination par CURSEUR sur la clé primaire, pas `offset` : un `offset` de
  // 200 000 fait relire 200 000 lignes à chaque tranche.
  for (;;) {
    const sql =
      `select * from (${SELECTS[table]}) t` +
      (curseur === null ? '' : ` where t."${cle}" > $1`) +
      ` order by t."${cle}" limit ${TRANCHE}`;
    const params: string[] = curseur === null ? [] : [curseur];
    const rows: Ligne[] = (await query<Ligne>(sql, params)).rows;
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!out.write(`${JSON.stringify(row)}\n`)) {
        // Respecter la contre-pression : sans ça, le tampon de flux remplace
        // simplement le tampon de requête qu'on vient d'éviter.
        await new Promise<void>((resolve) => out.once('drain', resolve));
      }
    }

    total += rows.length;
    const derniere: Ligne | undefined = rows[rows.length - 1];
    curseur = derniere === undefined ? null : String(derniere[cle]);
    if (rows.length < TRANCHE) break;
  }

  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });

  return total;
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
  // jsonb : voir JSON_COLUMNS juste en dessous.
  candidates: '::jsonb',
  llm_raw: '::jsonb',
  payload: '::jsonb',
  price_breakdown: '::jsonb',
  breakdown: '::jsonb',
};

/**
 * Colonnes `jsonb` dont la valeur doit être RÉ-SÉRIALISÉE à la main.
 *
 * `JSON.parse` d'une ligne du dump rend un objet ou un TABLEAU JavaScript.
 * node-pg sérialise un objet en JSON — ce qui marche — mais un tableau en
 * littéral de tableau Postgres, `{"...","..."}`. Postgres répond alors
 * « invalid input syntax for type json » et la restauration s'arrête.
 *
 * `scans.candidates` est justement un tableau, et il est renseigné sur
 * pratiquement tout scan réel. La restauration était donc cassée dès qu'il y
 * avait quelque chose à restaurer : le test ne l'avait pas vu parce qu'il
 * fabriquait des scans SANS candidats. Une sauvegarde qui ne se restaure pas
 * n'est pas une sauvegarde.
 *
 * La liste est explicite plutôt que devinée du type JavaScript : deviner
 * casserait le jour où une vraie colonne tableau Postgres entrerait dans la
 * sauvegarde.
 */
const JSON_COLUMNS = new Set([
  'candidates',
  'llm_raw',
  'payload',
  'price_breakdown',
  'breakdown',
]);

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

  const valeur = (row: Record<string, unknown>, c: string): unknown => {
    const v = row[c];
    return JSON_COLUMNS.has(c) && v !== null && v !== undefined ? JSON.stringify(v) : v;
  };

  /**
   * Insertion PAR LOTS. Une ligne par requête, c'est un aller-retour réseau
   * par enregistrement : mesuré, restaurer 30 000 lignes dépassait deux
   * minutes et faisait échouer le test d'aller-retour. Un backup qu'on ne peut
   * pas restaurer dans un temps utile n'est qu'à moitié un backup.
   *
   * Le lot est borné par la limite dure de Postgres, 65 535 paramètres liés
   * par requête.
   */
  async function flush(cols: string[], lot: Record<string, unknown>[]): Promise<void> {
    if (lot.length === 0) return;

    const params: unknown[] = [];
    const tuples = lot.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(valeur(row, c));
        return `$${params.length}${CASTS[c] ?? ''}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    const { rowCount } = await query(
      `insert into ${table} (${cols.map((c) => `"${c}"`).join(', ')})
       values ${tuples.join(', ')}
       on conflict do nothing`,
      params,
    );
    inserted += rowCount ?? 0;
  }

  // Regroupées par signature de colonnes : un fichier édité à la main, ou une
  // sauvegarde d'une version antérieure du schéma, peut mélanger des lignes qui
  // n'ont pas les mêmes clés. Les insérer dans le même lot produirait des
  // valeurs décalées d'une colonne — pire qu'un échec.
  let signature = '';
  let cols: string[] = [];
  let lot: Record<string, unknown>[] = [];

  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>;
    const k = Object.keys(row);
    if (k.length === 0) continue;

    const sig = k.join(',');
    const maxLot = Math.max(1, Math.floor(60_000 / k.length));
    if (sig !== signature || lot.length >= maxLot) {
      await flush(cols, lot);
      signature = sig;
      cols = k;
      lot = [];
    }
    lot.push(row);
  }
  await flush(cols, lot);

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
