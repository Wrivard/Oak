/**
 * Répétition générale : le parcours exact de demain matin, sans toi.
 *
 *   pnpm repetition [nb_cartes] [url]
 *
 * Ce que fait ce script, dans l'ordre, par les MÊMES chemins que l'écran :
 *
 *   1. POST /api/upload par paquets de 10, avec des pages recto/verso alternées
 *   2. PUT /api/upload pour clore le lot et déclencher l'appariement
 *   3. attend que le worker draine, en échantillonnant
 *   4. vérifie la RÉCONCILIATION : pages envoyées → cartes attendues → scans créés
 *
 * Pourquoi ça existe : `pnpm loadtest` dépose les fichiers directement dans
 * l'inbox. Il ne traverse ni la route HTTP, ni l'appariement duplex — donc il
 * n'aurait pas vu qu'un second envoi vers le même lot écrasait le premier, ni
 * qu'un dossier glissé rendait zéro fichier. Les deux pannes les plus coûteuses
 * du projet étaient en amont de ce que le test de charge mesurait.
 *
 * Le worker doit tourner à côté :  node --import tsx worker/index.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { closePool, query } from '../lib/db.js';

const CACHE = process.env['LOADTEST_CACHE'] ?? './.loadtest-cache';
const SESSION = 'repetition';
const BATCH = 10;

interface Compte {
  total: number;
  resolus: number;
  review: number;
  erreur: number;
  autres: number;
}

async function compter(): Promise<Compte> {
  const { rows } = await query<{ status: string; n: string }>(
    `select status::text, count(*)::text as n
       from scans
      where session_id in (select id from sessions where name = $1)
      group by status`,
    [SESSION],
  );
  const par = (s: string): number => Number(rows.find((r) => r.status === s)?.n ?? 0);
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  return {
    total,
    resolus: par('resolved'),
    review: par('needs_review'),
    erreur: par('error'),
    autres: total - par('resolved') - par('needs_review') - par('error'),
  };
}

async function enAttente(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `select count(*)::text as n from jobs where status in ('queued','running')`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Un dos de carte. Le même fichier pour toutes les pages paires : deux scans du
 * même dos physique donnent des empreintes quasi identiques, c'est précisément
 * ce que la vérification d'alternance attend. Un dos aplati en couleur unie
 * donnerait un pHash instable — mesuré, ça avait faussé une série de tests.
 */
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
             <rect x="117" y="497" width="500" height="30" fill="#111"/>
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

async function main(): Promise<void> {
  const cartes = Number(process.argv[2] ?? 40);
  const base = process.argv[3] ?? 'http://127.0.0.1:3000';

  const noms = (await readdir(CACHE)).filter((n) => n.endsWith('.jpg')).slice(0, cartes);
  if (noms.length < cartes) {
    console.log(
      `  ${noms.length} images en cache pour ${cartes} demandées — lance d'abord ` +
        `\`pnpm loadtest ${cartes}\` pour remplir ${CACHE}.`,
    );
  }
  const verso = await dos();

  // Les pages alternent recto/verso, comme le sort un ADF duplex : image0001
  // est un recto, image0002 son verso, et ainsi de suite.
  const pages: { nom: string; buf: Buffer }[] = [];
  for (const [i, nom] of noms.entries()) {
    pages.push({ nom: `image${String(2 * i + 1).padStart(4, '0')}.jpg`, buf: await readFile(join(CACHE, nom)) });
    pages.push({ nom: `image${String(2 * i + 2).padStart(4, '0')}.jpg`, buf: verso });
  }

  const avant = await compter();
  console.log(`\n  ${pages.length} pages → ${noms.length} cartes attendues`);
  console.log(`  lot « ${SESSION} », ${avant.total} scans déjà présents\n`);

  const t0 = Date.now();
  let acceptees = 0;
  const refusees: { name: string; reason: string }[] = [];

  for (let i = 0; i < pages.length; i += BATCH) {
    const form = new FormData();
    form.set('session', SESSION);
    form.set('variant', 'normal');
    form.set('condition', 'NM');
    form.set('language', 'en');
    for (const p of pages.slice(i, i + BATCH)) {
      form.append('files', new File([new Uint8Array(p.buf)], p.nom, { type: 'image/jpeg' }));
    }
    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`POST paquet ${i / BATCH} : HTTP ${res.status}`);
    const body = (await res.json()) as { accepted: number; rejected: typeof refusees };
    acceptees += body.accepted;
    refusees.push(...body.rejected);
    process.stdout.write(`\r  envoi ${acceptees}/${pages.length}`);
  }

  const secondes = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\r  envoi ${acceptees}/${pages.length} en ${secondes} s`);
  if (refusees.length > 0) {
    console.log(`  ${refusees.length} refusées : ${refusees.slice(0, 3).map((r) => `${r.name} (${r.reason})`).join(', ')}`);
  }

  const fin = await fetch(`${base}/api/upload`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESSION, mode: 'duplex' }),
  });
  if (!fin.ok) throw new Error(`PUT : HTTP ${fin.status}`);
  console.log('  lot clos, appariement enfilé\n');

  // On attend le silence de la file, pas un délai fixe : un délai fixe déclare
  // vert un pipeline qui n'a simplement pas encore commencé.
  const debut = Date.now();
  let calme = 0;
  for (;;) {
    await sleep(3000);
    const [q, c] = [await enAttente(), await compter()];
    const min = ((Date.now() - debut) / 60000).toFixed(1);
    process.stdout.write(
      `\r  ${min} min · file ${q} · ${c.total} scans · ${c.resolus} résolus · ${c.review} review · ${c.erreur} erreur   `,
    );
    calme = q === 0 ? calme + 1 : 0;
    if (calme >= 3) break;
    if (Date.now() - debut > 20 * 60_000) {
      console.log('\n  20 min sans fin — j’arrête d’attendre.');
      break;
    }
  }

  const apres = await compter();
  const crees = apres.total - avant.total;
  const minutes = (Date.now() - debut) / 60000;

  console.log('\n');
  console.log(`  pages envoyées     ${acceptees}`);
  console.log(`  cartes attendues   ${noms.length}`);
  console.log(`  scans créés        ${crees}`);
  console.log(`  débit              ${(crees / minutes).toFixed(1)} cartes/min`);
  console.log('');
  console.log(`  résolus            ${apres.resolus - avant.resolus}`);
  console.log(`  en review          ${apres.review - avant.review}`);
  console.log(`  en erreur          ${apres.erreur - avant.erreur}`);
  if (apres.autres > 0) console.log(`  encore en cours    ${apres.autres}`);
  console.log('');

  // LA vérification. Une carte physiquement scannée sans scan en base est une
  // perte silencieuse — le seul échec du système qu'on ne rattrape jamais.
  if (crees !== noms.length) {
    console.log(`  ÉCHEC — ${noms.length} cartes envoyées, ${crees} scans créés.`);
    process.exitCode = 1;
  } else if (apres.erreur - avant.erreur > 0) {
    console.log(`  ${apres.erreur - avant.erreur} scan(s) en erreur — voir /batches.`);
    process.exitCode = 1;
  } else {
    console.log('  Réconciliation exacte : aucune carte perdue.');
  }

  await closePool();
}

void main();
