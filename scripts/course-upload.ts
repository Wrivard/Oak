/**
 * La course de deux envois concurrents vers le même lot.
 *
 *   pnpm course [url]
 *
 * Le rang des fichiers était calculé en lisant le répertoire au début de chaque
 * requête. Deux requêtes concurrentes lisaient donc le même état et écrivaient
 * les MÊMES noms : les pages de la première étaient écrasées par la seconde,
 * sans erreur, sans message. Des cartes physiquement scannées sans aucune ligne
 * d'inventaire.
 *
 * Le client envoie ses paquets en série, donc un seul onglet ne peut pas
 * déclencher la course. Deux onglets, ou deux dossiers envoyés en parallèle, y
 * suffisent — et c'est un geste normal quand on a deux piles à traiter.
 *
 * Ce script envoie N paquets EN MÊME TEMPS et compte ce qui a survécu.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { closePool, query } from '../lib/db.js';

const SESSION = 'course-essai';
const STORE = process.env['UPLOAD_DIR'] ?? './uploads';
const PAQUETS = 6;
const PAR_PAQUET = 8;

async function image(teinte: number): Promise<Buffer> {
  return sharp({
    create: { width: 120, height: 168, channels: 3, background: { r: teinte, g: 60, b: 120 } },
  })
    .jpeg()
    .toBuffer();
}

async function nettoyer(): Promise<void> {
  await query(
    `delete from jobs where payload->>'session_id' in (
       select id::text from sessions where name = $1)`,
    [SESSION],
  );
  await query(
    `delete from scans where session_id in (select id from sessions where name = $1)`,
    [SESSION],
  );
  await query('delete from sessions where name = $1', [SESSION]);
}

async function main(): Promise<void> {
  const base = process.argv[2] ?? 'http://127.0.0.1:3000';
  await nettoyer();

  const attendu = PAQUETS * PAR_PAQUET;
  console.log(`\n  ${PAQUETS} paquets de ${PAR_PAQUET} pages, envoyés EN MÊME TEMPS`);
  console.log(`  ${attendu} fichiers distincts attendus sur le disque\n`);

  const envois = Array.from({ length: PAQUETS }, async (_, p) => {
    const form = new FormData();
    form.set('session', SESSION);
    form.set('variant', 'normal');
    form.set('condition', 'NM');
    form.set('language', 'en');
    form.set('offset', '0');
    for (let i = 0; i < PAR_PAQUET; i++) {
      const buf = await image((p * 37 + i * 11) % 255);
      form.append('files', new File([new Uint8Array(buf)], `p${p}-${i}.jpg`, { type: 'image/jpeg' }));
    }
    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`paquet ${p} : HTTP ${res.status}`);
    return (await res.json()) as { accepted: number };
  });

  const resultats = await Promise.all(envois);
  const acceptees = resultats.reduce((s, r) => s + r.accepted, 0);

  const fichiers = (await readdir(join(STORE, SESSION))).filter((n) => /^\d{6}\./.test(n));
  const distincts = new Set(fichiers).size;

  console.log(`  acceptées par la route   ${acceptees}`);
  console.log(`  fichiers sur le disque   ${distincts}`);

  const { rows } = await query<{ n: number }>(
    'select page_count as n from sessions where name = $1',
    [SESSION],
  );
  console.log(`  compteur de pages        ${rows[0]?.n ?? 0}\n`);

  if (distincts !== attendu) {
    console.log(`  ÉCHEC — ${attendu - distincts} page(s) écrasée(s) en silence.`);
    process.exitCode = 1;
  } else {
    console.log('  Aucune page écrasée : les plages allouées sont disjointes.');
  }

  await nettoyer();
  await closePool();
}

void main();
