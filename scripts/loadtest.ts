/**
 * Test de charge. Voir docs/05-production.md §3.4.
 *
 *   pnpm loadtest [nb_scans] [nb_images_distinctes]
 *
 * Dépose N fichiers dans l'inbox et ÉCHANTILLONNE pendant que le worker draine :
 * débit, profondeur de file, mémoire, répartition des résolutions.
 *
 * Le worker doit tourner à côté :
 *   node --import tsx worker/index.ts
 *
 * HONNÊTETÉ SUR CE QUE ÇA MESURE — ce sont des renders officiels du catalogue,
 * pas des scans ADF à 300 dpi. Le débit du pipeline (I/O, hachage, embedding,
 * requêtes) est représentatif ; le TAUX DE RÉSOLUTION ne l'est pas, parce que
 * l'OCR se comporte différemment sur une vraie numérisation. Ne tire pas de
 * conclusion sur le taux de review d'ici : c'est l'expérience 1bis qui le dira.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closePool, query } from '../lib/db.js';
import { log } from '../lib/log.js';

const INBOX = process.env['INBOX_DIR'] ?? './inbox';
const CACHE = process.env['LOADTEST_CACHE'] ?? './.loadtest-cache';
const SESSION = 'loadtest';
const SAMPLE_MS = 5_000;

interface Sample {
  t: number;
  ingested: number;
  fingerprinted: number;
  done: number;
  queued: number;
  dead: number;
  rssMb: number;
}

async function imagePool(size: number): Promise<Buffer[]> {
  await mkdir(CACHE, { recursive: true });

  const { rows } = await query<{ id: string; image_large: string }>(
    `select id, image_large from cards
      where image_large like '%pokemontcg.io%'
      order by md5(id) limit $1`,
    [size],
  );

  const pool: Buffer[] = [];
  for (const row of rows) {
    const path = join(CACHE, `${row.id}.jpg`);
    try {
      pool.push(await readFile(path));
      continue;
    } catch {
      // pas encore en cache
    }
    try {
      const res = await fetch(row.image_large, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(path, buf);
      pool.push(buf);
    } catch (err) {
      log.debug('image de charge indisponible', { card_id: row.id, err });
    }
  }
  return pool;
}

async function progress(sessionId: string): Promise<Omit<Sample, 't' | 'rssMb'>> {
  const { rows } = await query<{
    ingested: string;
    fingerprinted: string;
    done: string;
    queued: string;
    dead: string;
  }>(
    `select
       (select count(*) from scans where session_id = $1)::text as ingested,
       (select count(*) from scans where session_id = $1
          and status <> 'pending')::text as fingerprinted,
       (select count(*) from scans where session_id = $1
          and status in ('resolved','needs_review'))::text as done,
       (select count(*) from jobs where status in ('queued','failed'))::text as queued,
       (select count(*) from jobs where status = 'dead')::text as dead`,
    [sessionId],
  );
  const r = rows[0]!;
  return {
    ingested: Number(r.ingested),
    fingerprinted: Number(r.fingerprinted),
    done: Number(r.done),
    queued: Number(r.queued),
    dead: Number(r.dead),
  };
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
}

async function main(): Promise<void> {
  const total = Number(process.argv[2] ?? 2000);
  const distinct = Number(process.argv[3] ?? 200);

  log.info('test de charge — préparation', { total, images_distinctes: distinct });

  const pool = await imagePool(distinct);
  if (pool.length === 0) throw new Error('aucune image disponible pour le test');

  const { rows } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition, expected_count)
     values ($1,'normal','NM',$2)
     on conflict do nothing
     returning id`,
    [SESSION, total],
  );
  const sessionId =
    rows[0]?.id ??
    (await query<{ id: string }>('select id from sessions where name = $1', [SESSION]))
      .rows[0]!.id;

  await mkdir(INBOX, { recursive: true });
  const started = Date.now();

  // Dépôt : le watcher ramasse au fil de l'eau, comme un vrai ADF qui débite.
  for (let i = 1; i <= total; i++) {
    const buf = pool[i % pool.length] as Buffer;
    await writeFile(join(INBOX, `${SESSION}_${String(i).padStart(6, '0')}_front.jpg`), buf);
  }
  log.info('fichiers déposés', { total, ms: Date.now() - started });

  const samples: Sample[] = [];
  let lastDone = 0;
  let stalled = 0;

  for (;;) {
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
    const p = await progress(sessionId);
    const sample: Sample = {
      t: Date.now() - started,
      ...p,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
    samples.push(sample);

    log.info('charge', {
      pct: Math.round((100 * p.done) / total),
      ...p,
      cartes_par_min:
        Math.round((p.done / ((Date.now() - started) / 60_000)) * 10) / 10,
    });

    if (p.done >= total) break;

    // Rien n'avance depuis deux minutes : le worker est mort ou bloqué.
    stalled = p.done === lastDone ? stalled + 1 : 0;
    lastDone = p.done;
    if (stalled >= 24) {
      log.error('aucun progrès depuis 2 minutes, arrêt', { done: p.done, total });
      break;
    }
  }

  const elapsedMin = (Date.now() - started) / 60_000;
  const mix = await query<{ match_source: string | null; status: string; n: string }>(
    `select match_source, status, count(*)::text as n
       from scans where session_id = $1 group by 1,2 order by 3 desc`,
    [sessionId],
  );

  const durations = await query<{ ms: number }>(
    `select extract(epoch from (completed_at - created_at)) * 1000 as ms
       from jobs where status = 'done' and completed_at is not null`,
  );
  const ms = durations.rows.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n));

  log.info('=== RÉSULTAT DU TEST DE CHARGE ===', {
    scans: total,
    images_distinctes: pool.length,
    duree_min: Math.round(elapsedMin * 10) / 10,
    cartes_par_min: Math.round((total / elapsedMin) * 10) / 10,
    file_max: Math.max(...samples.map((s) => s.queued)),
    rss_max_mb: Math.max(...samples.map((s) => s.rssMb)),
    jobs_morts: samples[samples.length - 1]?.dead ?? 0,
    job_p50_ms: Math.round(percentile(ms, 0.5)),
    job_p95_ms: Math.round(percentile(ms, 0.95)),
    repartition: mix.rows,
  });
}

main()
  .catch((err: unknown) => {
    log.error('test de charge échoué', { err });
    process.exitCode = 1;
  })
  .finally(() => closePool());
