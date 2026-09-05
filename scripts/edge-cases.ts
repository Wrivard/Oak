/**
 * Ce qui sort vraiment d'un scanner, et ce qui casse.
 *
 *   pnpm edge [url]
 *
 * Le test de charge et la répétition envoient des JPEG bien formés. Un ADF réel
 * produit autre chose : du TIFF, du 600 dpi, du niveaux de gris, du CMJN, des
 * pages blanches, et de temps en temps un fichier tronqué parce que le chariot
 * a bougé. Chacun de ces cas doit soit passer, soit ÉCHOUER VISIBLEMENT — la
 * seule issue interdite, c'est de disparaître.
 *
 * Ce script les fabrique, les envoie par la vraie route, et regarde ce que le
 * pipeline en fait.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { closePool, query } from '../lib/db.js';

const SESSION = 'edge-cases';

interface Cas {
  nom: string;
  attendu: 'accepté' | 'refusé';
  pourquoi: string;
  faire: () => Promise<{ buf: Buffer; ext: string }>;
}

const motif = (w: number, h: number, teinte: number): Buffer =>
  Buffer.from(
    `<svg width="${w}" height="${h}">
       <rect width="${w}" height="${h}" fill="hsl(${teinte},60%,55%)"/>
       <circle cx="${w * 0.5}" cy="${h * 0.4}" r="${w * 0.3}" fill="hsl(${(teinte + 120) % 360},70%,40%)"/>
       <rect x="${w * 0.1}" y="${h * 0.75}" width="${w * 0.8}" height="${h * 0.12}" fill="#111"/>
     </svg>`,
  );

const CAS: Cas[] = [
  {
    nom: 'jpeg300',
    attendu: 'accepté',
    pourquoi: 'la sortie nominale de l’ADF',
    faire: async () => ({
      buf: await sharp(motif(750, 1050, 10)).jpeg({ quality: 85 }).toBuffer(),
      ext: 'jpg',
    }),
  },
  {
    nom: 'tiff',
    attendu: 'accepté',
    pourquoi: 'le format par défaut de beaucoup de pilotes de scanner',
    faire: async () => ({
      buf: await sharp(motif(750, 1050, 40)).tiff({ compression: 'lzw' }).toBuffer(),
      ext: 'tif',
    }),
  },
  {
    nom: 'gris',
    attendu: 'accepté',
    pourquoi: 'un scan en niveaux de gris n’a qu’un seul canal',
    faire: async () => ({
      buf: await sharp(motif(750, 1050, 70)).grayscale().jpeg().toBuffer(),
      ext: 'jpg',
    }),
  },
  {
    nom: 'cmjn',
    attendu: 'accepté',
    pourquoi: 'certains pilotes sortent du CMJN, que beaucoup de code suppose RVB',
    faire: async () => ({
      buf: await sharp(motif(750, 1050, 100)).toColourspace('cmyk').jpeg().toBuffer(),
      ext: 'jpg',
    }),
  },
  {
    nom: 'paysage',
    attendu: 'accepté',
    pourquoi: 'une carte posée en travers sort en paysage',
    faire: async () => ({
      buf: await sharp(motif(1050, 750, 130)).jpeg().toBuffer(),
      ext: 'jpg',
    }),
  },
  {
    nom: 'grand600',
    attendu: 'accepté',
    pourquoi: '600 dpi fait 1500x2100 — ni lenteur ni explosion mémoire',
    faire: async () => ({
      buf: await sharp(motif(1500, 2100, 160)).jpeg({ quality: 92 }).toBuffer(),
      ext: 'jpg',
    }),
  },
  {
    nom: 'blanche',
    attendu: 'accepté',
    pourquoi: 'un intercalaire doit entrer et finir en review, pas disparaître',
    faire: async () => ({
      buf: await sharp({
        create: { width: 750, height: 1050, channels: 3, background: '#ffffff' },
      })
        .jpeg()
        .toBuffer(),
      ext: 'jpg',
    }),
  },
  {
    nom: 'minuscule',
    attendu: 'accepté',
    pourquoi: 'une vignette de 32 px ne doit pas casser le hachage 32x32',
    faire: async () => ({
      buf: await sharp(motif(32, 45, 200)).jpeg().toBuffer(),
      ext: 'jpg',
    }),
  },
  {
    nom: 'tronque',
    attendu: 'refusé',
    pourquoi: 'un fichier coupé doit échouer BRUYAMMENT, jamais être avalé',
    faire: async () => {
      const complet = await sharp(motif(750, 1050, 250)).jpeg().toBuffer();
      return { buf: complet.subarray(0, Math.floor(complet.length / 3)), ext: 'jpg' };
    },
  },
  {
    nom: 'pasimage',
    attendu: 'refusé',
    pourquoi: 'un PDF ou un texte glissé par erreur',
    faire: async () => ({ buf: Buffer.from('ceci n’est pas une image'), ext: 'jpg' }),
  },
];

async function main(): Promise<void> {
  const base = process.argv[2] ?? 'http://127.0.0.1:3000';

  console.log('');
  const form = new FormData();
  form.set('session', SESSION);
  form.set('variant', 'normal');
  form.set('condition', 'NM');
  form.set('language', 'en');
  form.set('offset', '0');

  let rang = 0;
  for (const cas of CAS) {
    const { buf, ext } = await cas.faire();
    rang += 1;
    form.append(
      'files',
      new File(
        [new Uint8Array(buf)],
        `${String(rang).padStart(4, '0')}-${cas.nom}.${ext}`,
        // Le TIFF part avec un type vide, comme le fait Chrome : c'est le cas
        // qui était silencieusement jeté avant.
        { type: ext === 'tif' ? '' : 'image/jpeg' },
      ),
    );
    console.log(
      `  ${cas.nom.padEnd(11)} ${(buf.length / 1024).toFixed(0).padStart(5)} Ko  ${cas.pourquoi}`,
    );
  }

  const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
  const body = (await res.json()) as {
    accepted: number;
    rejected: { name: string; reason: string }[];
  };
  console.log(`\n  route : ${body.accepted} acceptées, ${body.rejected.length} refusées`);
  for (const r of body.rejected) console.log(`    ${r.name} — ${r.reason}`);

  // front_only : ces pages ne forment pas des paires recto/verso.
  const fin = await fetch(`${base}/api/upload`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESSION, mode: 'front_only' }),
  });
  if (!fin.ok) throw new Error(`PUT : HTTP ${fin.status}`);

  let calme = 0;
  for (let i = 0; i < 100 && calme < 3; i++) {
    await sleep(3000);
    const { rows } = await query<{ n: string }>(
      `select count(*)::text as n from jobs where status in ('queued','running')`,
    );
    calme = Number(rows[0]?.n) === 0 ? calme + 1 : 0;
  }

  const { rows } = await query<{ front_path: string; status: string; error: string | null }>(
    `select front_path, status::text, error
       from scans
      where session_id in (select id from sessions where name = $1)
      order by seq`,
    [SESSION],
  );

  console.log(`\n  ${rows.length} scans créés\n`);
  // La route RENOMME les fichiers en `000001.ext` : le nom d'origine ne survit
  // pas. Le rang, lui, suit exactement l'ordre d'envoi — c'est donc lui qui
  // relie un scan à son cas.
  const parRang = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    const rang = Number(/(\d{6})\.[a-z]+$/i.exec(r.front_path)?.[1] ?? 0);
    if (rang > 0) parRang.set(rang, r);
  }

  let echecs = 0;
  for (const [i, cas] of CAS.entries()) {
    const scan = parRang.get(i + 1);
    // Un cas « accepté » doit avoir produit un scan exploitable. Un cas
    // « refusé » doit laisser une LIGNE ÉCARTÉE : disparaître sans trace est
    // la seule issue interdite.
    const ok =
      cas.attendu === 'accepté'
        ? scan !== undefined && scan.status !== 'rejected'
        : scan !== undefined && scan.status === 'rejected';
    if (!ok) echecs += 1;
    const etat = scan
      ? `${scan.status}${scan.error ? ` — ${scan.error.slice(0, 66)}` : ''}`
      : 'AUCUNE LIGNE — la page a disparu';
    console.log(`  ${ok ? ' ok  ' : 'ECHEC'}  ${cas.nom.padEnd(11)} ${etat}`);
  }

  const morts = await query<{ n: string }>(
    `select count(*)::text as n from jobs where status = 'dead'`,
  );
  console.log(`\n  jobs morts : ${morts.rows[0]?.n}`);
  if (echecs > 0) {
    console.log(`  ${echecs} cas en échec.`);
    process.exitCode = 1;
  } else {
    console.log('  Tous les cas se comportent comme prévu.');
  }

  await closePool();
}

void main();
