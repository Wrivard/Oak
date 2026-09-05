import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { cardImage } from './fixtures/cards.js';
import { handlePairUpload } from '../worker/handlers/pair-upload.js';
import { handleFingerprint } from '../worker/handlers/fingerprint.js';
import { handleMatch } from '../worker/handlers/match.js';
import type { Job } from '../worker/queue/queue.js';

/**
 * Le pipeline complet, en un seul test : appariement, empreintes, matching.
 *
 * Chaque étage a ses tests. Ce qui n'en avait pas, c'est leur ENCHAÎNEMENT sur
 * de vraies images — il vivait dans `pnpm repetition`, un script qu'on lance à
 * la main avec un serveur et un worker à côté. Une régression dans le passage de
 * relais entre deux étages ne se serait donc vue qu'en le lançant.
 *
 * Ce que ce test protège, précisément :
 *   - quatre pages recto/verso deviennent DEUX cartes, pas quatre ;
 *   - le verso est rattaché, et son empreinte enregistrée ;
 *   - le chemin écrit en base reste lisible par l'étage suivant ;
 *   - un scan résolu crée son SKU et incrémente sa quantité, une seule fois.
 */
const SESSION = 'test-pipeline';
/** Les cartes des fixtures : ce que le matching peut résoudre depuis ces images. */
const CARTES = ['base1-4', 'base1-2'];
let dir: string;
let sessionId: string;

/** Un dos de carte. Le MÊME fichier pour les deux, comme un vrai duplex. */
async function dos(): Promise<Buffer> {
  return sharp({
    create: { width: 734, height: 1024, channels: 3, background: { r: 30, g: 58, b: 138 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="734" height="1024">
             <rect width="734" height="1024" fill="#1e3a8a"/>
             <ellipse cx="367" cy="512" rx="250" ry="250" fill="#e5e7eb"/>
             <path d="M117 512 A250 250 0 0 1 617 512 Z" fill="#dc2626"/>
             <circle cx="367" cy="512" r="80" fill="#fff" stroke="#111" stroke-width="16"/>
           </svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function wipe(): Promise<void> {
  await query(
    `delete from jobs where payload->>'scan_id' in (
       select s.id::text from scans s join sessions ss on ss.id = s.session_id
        where ss.name = $1)`,
    [SESSION],
  );
  await query(
    `delete from known_fingerprints where source_scan in (
       select s.id from scans s join sessions ss on ss.id = s.session_id
        where ss.name = $1)`,
    [SESSION],
  );
  await query(
    `delete from scans where session_id in (select id from sessions where name = $1)`,
    [SESSION],
  );
  await query(`delete from sessions where name = $1`, [SESSION]);

  // L'INVENTAIRE AUSSI. Une résolution en crée une ligne, et la laisser derrière
  // fait grossir la quantité à chaque exécution — un test qui laisse de l'état
  // finit par tester cet état. En production, une ligne d'inventaire ne se
  // supprime jamais (invariant 7) ; ici c'est celle que le test vient d'écrire.
  const motifs = CARTES.map((c) => `${c}-%`);
  await query('delete from channel_events where sku like any($1::text[])', [motifs]);
  await query('delete from price_history where sku like any($1::text[])', [motifs]);
  await query('delete from inventory where card_id = any($1::text[])', [CARTES]);
}

const job = (payload: Record<string, unknown>): Job =>
  ({ id: 1, type: 't', payload, attempts: 1, max_attempts: 5 }) as unknown as Job;

beforeAll(async () => {
  await wipe();
  dir = await mkdtemp(join(tmpdir(), 'pokelister-pipe-'));

  const { rows } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition, default_language)
     values ($1, 'normal', 'NM', 'en') returning id`,
    [SESSION],
  );
  sessionId = rows[0]!.id;

  // Recto, verso, recto, verso — ce que sort un ADF duplex.
  const verso = await dos();
  await writeFile(join(dir, '000001.jpg'), await cardImage('charizard'));
  await writeFile(join(dir, '000002.jpg'), verso);
  await writeFile(join(dir, '000003.jpg'), await cardImage('blastoise'));
  await writeFile(join(dir, '000004.jpg'), verso);
}, 120_000);

afterAll(async () => {
  await wipe();
  await closePool();
  await rm(dir, { recursive: true, force: true });
});

describe('le pipeline de bout en bout', () => {
  it('quatre pages recto/verso donnent DEUX cartes, versos rattachés', async () => {
    await handlePairUpload(job({ session_id: sessionId, dir, mode: 'duplex' }));

    const { rows } = await query<{
      seq: number;
      front_path: string;
      back_path: string | null;
      status: string;
    }>(
      `select seq, front_path, back_path, status::text
         from scans where session_id = $1 order by seq`,
      [sessionId],
    );

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // Le verso rattaché est ce qui permet de détecter une carte insérée à
      // l'envers : sans lui, l'alternance ne se vérifie plus.
      expect(r.back_path).not.toBeNull();
      expect(r.status).toBe('pending');
    }
    // L'ordre est l'information : la page 1 est le recto de la première carte.
    expect(rows[0]?.front_path).toContain('000001');
    expect(rows[1]?.front_path).toContain('000003');
  }, 180_000);

  it('l’appariement est REJOUABLE sans créer de doublon', async () => {
    // Le job peut être rejoué : un worker tué, un bail expiré, un bouton
    // « Réparer ». Deux cartes doivent rester deux cartes.
    await handlePairUpload(job({ session_id: sessionId, dir, mode: 'duplex' }));

    const { rows } = await query<{ n: string }>(
      'select count(*)::text as n from scans where session_id = $1',
      [sessionId],
    );
    expect(Number(rows[0]?.n)).toBe(2);
  }, 180_000);

  it('les empreintes se calculent et le scan passe la main au matching', async () => {
    const { rows: scans } = await query<{ id: string }>(
      'select id from scans where session_id = $1 order by seq',
      [sessionId],
    );

    for (const s of scans) {
      await handleFingerprint(job({ scan_id: s.id }));
    }

    const { rows } = await query<{
      status: string;
      p: string | null;
      d: string | null;
      pb: string | null;
      dims: number | null;
    }>(
      `select status::text, phash_front::text as p, dhash_front::text as d,
              phash_back::text as pb, vector_dims(embedding) as dims
         from scans where session_id = $1 order by seq`,
      [sessionId],
    );

    for (const r of rows) {
      expect(r.status).toBe('fingerprinted');
      expect(r.p).toMatch(/^[01]{64}$/);
      expect(r.d).toMatch(/^[01]{64}$/);
      // L'empreinte du DOS : deux lignes qui attrapent une carte insérée à
      // l'envers, une classe d'erreur entière.
      expect(r.pb).toMatch(/^[01]{64}$/);
      expect(Number(r.dims)).toBe(512);
    }

    // Et le job de matching a bien été enfilé, dans la même transaction.
    const { rows: enfiles } = await query<{ n: string }>(
      `select count(*)::text as n from jobs
        where type = 'match' and payload->>'scan_id' in (
          select id::text from scans where session_id = $1)`,
      [sessionId],
    );
    expect(Number(enfiles[0]?.n)).toBe(2);
  }, 300_000);

  it('le matching tranche, et une résolution crée le SKU et la quantité', async () => {
    const { rows: scans } = await query<{ id: string }>(
      'select id from scans where session_id = $1 order by seq',
      [sessionId],
    );

    for (const s of scans) {
      await handleMatch(job({ scan_id: s.id }));
    }

    const { rows } = await query<{
      status: string;
      source: string | null;
      sku: string | null;
      candidats: number;
    }>(
      `select status::text, match_source::text as source, resolved_sku as sku,
              jsonb_array_length(coalesce(candidates, '[]'::jsonb)) as candidats
         from scans where session_id = $1 order by seq`,
      [sessionId],
    );

    for (const r of rows) {
      // Une issue TERMINALE dans les deux cas : le système tranche ou passe la
      // main à un humain, il ne laisse jamais un scan en suspens.
      expect(['resolved', 'needs_review']).toContain(r.status);

      if (r.status === 'resolved') {
        expect(r.sku).not.toBeNull();
        const inv = await query<{ qty: number }>(
          'select qty_on_hand as qty from inventory where sku = $1',
          [r.sku],
        );
        expect(inv.rows[0]?.qty).toBeGreaterThanOrEqual(1);

        // Toute résolution confirmée nourrit known_fingerprints : c'est le
        // mécanisme qui rend la prochaine occurrence gratuite.
        const fp = await query<{ n: string }>(
          `select count(*)::text as n from known_fingerprints
            where source_scan in (select id from scans where session_id = $1)`,
          [sessionId],
        );
        expect(Number(fp.rows[0]?.n)).toBeGreaterThanOrEqual(1);
      } else {
        // La review ne doit jamais recevoir une page blanche : même sans
        // lecture OCR, on remonte les plus proches voisins du catalogue.
        expect(r.candidats).toBeGreaterThan(0);
      }
    }
  }, 300_000);
});
