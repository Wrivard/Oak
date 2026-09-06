/**
 * Remplit la file de review avec des cartes RÉELLES, pour regarder l'écran.
 *
 *   pnpm demo:review          crée un lot `demo-review` de 12 scans
 *   pnpm demo:review --purge  l'efface
 *
 * Pourquoi ce script existe : sans scanner branché, la file de review est vide
 * ou pleine de scans sans candidat, sans image et sans prix. C'est un vrai cas
 * — le `no_data` du niveau 3 — mais c'est le cas RARE. Juger la mise en page
 * de l'écran où l'on passe des heures sur son cas dégénéré mène à optimiser le
 * vide.
 *
 * Ce que ça fabrique est donc le cas COURANT et coûteux : quatre ou cinq
 * candidats aux distances resserrées, des images officielles à comparer, un
 * numéro lu par l'OCR. Les images viennent du catalogue déjà en base ; aucune
 * n'est inventée.
 *
 * Tout porte le nom de lot `demo-review`, la purge est donc exacte.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closePool, query } from '../lib/db.js';
import { log } from '../lib/log.js';

const SESSION = 'demo-review';
const DIR = process.env['DEMO_SCAN_DIR'] ?? './.demo-scans';

/** Des noms qui ont été réimprimés souvent : c'est là que la review est dure. */
const NOMS = [
  'Charizard',
  'Blastoise',
  'Pikachu',
  'Mewtwo',
  'Gengar',
  'Umbreon',
  'Rayquaza',
  'Lugia',
  'Snorlax',
  'Gardevoir',
  'Sylveon',
  'Machamp',
];

interface Carte {
  id: string;
  name: string;
  number: string;
  set_name: string;
  printed_total: number | null;
  image_small: string;
}

async function purge(): Promise<void> {
  const etapes: [string, string][] = [
    [
      'scans',
      `delete from scans where session_id in (select id from sessions where name = $1)`,
    ],
    ['sessions', `delete from sessions where name = $1`],
  ];
  for (const [table, sql] of etapes) {
    const res = await query(sql, [SESSION]);
    log.info('purgé', { table, lignes: res.rowCount });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--purge')) {
    await purge();
    return;
  }

  // On repart de zéro à chaque exécution plutôt que d'empiler : un lot de démo
  // qui grossit à chaque lancement finit par cacher la file réelle.
  await purge();
  await mkdir(DIR, { recursive: true });

  const { rows: cartes } = await query<Carte>(
    `select id, name, number, set_name, printed_total, image_small
       from cards
      where image_small is not null and name = any($1)
      order by name, set_release nulls last`,
    [NOMS],
  );
  if (cartes.length === 0) {
    log.error('catalogue vide — lance pnpm seed:catalog avant', {});
    return;
  }

  const parNom = new Map<string, Carte[]>();
  for (const c of cartes) {
    const liste = parNom.get(c.name);
    if (liste) liste.push(c);
    else parNom.set(c.name, [c]);
  }

  const { rows: sess } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition, default_language)
     values ($1, 'normal', 'NM', 'en') returning id`,
    [SESSION],
  );
  const session = sess[0];
  if (!session) throw new Error('session non créée');

  let seq = 0;
  for (const [nom, liste] of parNom) {
    const vrai = liste[Math.min(1, liste.length - 1)];
    if (!vrai) continue;
    seq += 1;

    // L'image du scan : l'image officielle, posée sur disque. Un scanner
    // produirait une photo à plat, mais pour juger la MISE EN PAGE le ratio et
    // le cadrage sont les mêmes.
    const res = await fetch(vrai.image_small);
    if (!res.ok) {
      log.warn('image catalogue indisponible', { card_id: vrai.id, status: res.status });
      continue;
    }
    const chemin = join(DIR, `${vrai.id.replace(/[^\w-]/g, '_')}.png`);
    await writeFile(chemin, Buffer.from(await res.arrayBuffer()));

    // Distances CROISÉES et resserrées. Un premier candidat évident ne coûte
    // pas de temps humain ; ce qui en coûte, c'est trois rééditions du même
    // artwork séparées par un centième.
    const base = 0.06 + seq * 0.009;
    const candidats = liste.slice(0, 4 + (seq % 2)).map((c, k) => ({
      card_id: c.id,
      name: c.name,
      set_name: c.set_name,
      distance: Number((base + k * (0.010 + (seq % 3) * 0.004)).toFixed(4)),
    }));

    // Un scan sur quatre n'a rien de lisible : la bande du numéro est floue ou
    // masquée. C'est le cas où la décision se prend à l'oeil seul.
    const muet = seq % 4 === 0;

    await query(
      `insert into scans
         (session_id, seq, front_path, status, match_source, confidence,
          candidates, ocr_read, ocr_band, ocr_confidence, variant_conflict)
       values ($1, $2, $3, 'needs_review', 'catalog', $4, $5::jsonb, $6, $7, $8, $9)`,
      [
        session.id,
        seq,
        chemin,
        (1 - (candidats[0]?.distance ?? 0.2)).toFixed(3),
        JSON.stringify(candidats),
        muet ? null : `${vrai.number}/${vrai.printed_total ?? 102}`,
        muet ? null : (seq % 2) + 1,
        muet ? null : 71 + ((seq * 7) % 25),
        seq === 5,
      ],
    );
    log.info('scan de démo', { seq, nom, candidats: candidats.length });
  }
}

main()
  .catch((err: unknown) => {
    log.error('demo-review a échoué', { err });
    process.exitCode = 1;
  })
  .finally(closePool);
