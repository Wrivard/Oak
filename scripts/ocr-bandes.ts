/**
 * Quelle géométrie de crop lit le mieux le bloc numéro ?
 *
 *   pnpm ocr:bandes [dossier] [nb_images]
 *
 * Le taux de lecture OCR décide de l'étape 3 du plan de build. `/diagnostics` le
 * mesure sur ce qui passe, et dit quelle bande CONFIGURÉE a réussi — mais il ne
 * peut rien dire des bandes qu'on n'a pas essayées. Quand le taux est bas, la
 * question suivante est « est-ce le crop ou les photos ? », et elle restait sans
 * outil.
 *
 * Ce script essaie une GRILLE de géométries sur les mêmes images et compte, pour
 * chacune, combien de numéros sont lus — et combien sont JUSTES quand la vérité
 * est connue.
 *
 * La vérité vient du NOM DE FICHIER quand il porte un identifiant de carte du
 * catalogue (`base4-126.jpg`), ce qui est le cas du cache de `pnpm loadtest`.
 * Sans ça, on ne mesure que le taux de lecture, pas la justesse — et un crop qui
 * lit beaucoup de mauvais numéros est pire qu'un crop qui ne lit rien : le
 * niveau 2 résoudrait vers la mauvaise carte avec une confiance élevée.
 *
 * LA COMPOSITION PAR ÈRE EST AFFICHÉE, et ce n'est pas décoratif. Le bloc numéro
 * est en bas à GAUCHE sur le moderne et en bas à DROITE sur le vintage : un
 * échantillon d'une seule ère fait mécaniquement sortir l'autre bande à 0 %, et
 * on en conclut qu'elle est inutile alors qu'elle est simplement hors sujet.
 * C'est l'erreur que j'ai commise en lisant le premier tableau avant de regarder
 * ce qu'il y avait dedans.
 *
 * ⚠ Ce script NE MODIFIE AUCUN SEUIL. Il produit la mesure ; la décision de
 * changer `THRESHOLDS.ocr.bands` passe par le golden set (skill
 * card-matching-thresholds §1), qui est vide aujourd'hui.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { closePool, query } from '../lib/db.js';
import { parseNumberText } from '../lib/ocr/number.js';
import { THRESHOLDS } from '../lib/config/thresholds.js';

interface Geometrie {
  nom: string;
  top: number;
  left: number;
  width: number;
}

/** La grille. Les bandes configurées y sont, pour comparer à la référence. */
const GRILLE: Geometrie[] = [
  { nom: 'bas-gauche 0.88', top: 0.88, left: 0.0, width: 0.5 },
  { nom: 'bas-droite 0.88', top: 0.88, left: 0.5, width: 0.5 },
  { nom: 'pleine largeur 0.88', top: 0.88, left: 0.0, width: 1.0 },
  { nom: 'bas-gauche 0.84', top: 0.84, left: 0.0, width: 0.5 },
  { nom: 'bas-droite 0.84', top: 0.84, left: 0.5, width: 0.5 },
  { nom: 'pleine largeur 0.84', top: 0.84, left: 0.0, width: 1.0 },
  { nom: 'bas-gauche 0.91', top: 0.91, left: 0.0, width: 0.5 },
  { nom: 'bas-droite 0.91', top: 0.91, left: 0.5, width: 0.5 },
  { nom: 'pleine largeur 0.80', top: 0.8, left: 0.0, width: 1.0 },
];

async function crop(input: Buffer, g: Geometrie): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0) throw new Error('image sans dimensions');

  const top = Math.floor(h * g.top);
  const left = Math.floor(w * g.left);
  const width = Math.max(1, Math.floor(w * g.width));

  return sharp(input)
    .extract({ left, top, width: Math.min(width, w - left), height: Math.max(1, h - top) })
    .greyscale()
    .normalise()
    .resize({ width: Math.max(3, Math.floor(width * THRESHOLDS.ocr.upscale)) })
    .png()
    .toBuffer();
}

/** `base4-126.jpg` → le numéro imprimé de cette carte, si le catalogue la connaît. */
async function verites(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { rows } = await query<{ id: string; number: string }>(
    'select id, number from cards where id = any($1::text[])',
    [ids],
  );
  for (const r of rows) out.set(r.id, r.number.toUpperCase());
  return out;
}

/** La composition de l'échantillon, par ère. Voir le commentaire de tête. */
async function composition(ids: readonly string[]): Promise<{ ere: string; n: number }[]> {
  if (ids.length === 0) return [];
  const { rows } = await query<{ ere: string; n: string }>(
    `select case
              when set_release >= date '2022-01-01' then '4 moderne'
              when set_release >= date '2019-01-01' then '3 SWSH'
              when set_release >= date '2011-01-01' then '2 BW/XY/SM'
              when set_release is not null          then '1 vintage'
              else '5 inconnue'
            end as ere,
            count(*)::text as n
       from cards where id = any($1::text[])
      group by 1 order by 1`,
    [ids],
  );
  return rows.map((r) => ({ ere: r.ere, n: Number(r.n) }));
}

const AVERTISSEMENT_UNE_ERE = [
  '  ⚠ UNE SEULE ÈRE dans l’échantillon. Le bloc numéro est en bas à GAUCHE sur le',
  '    moderne et en bas à DROITE sur le vintage : l’autre bande sortira',
  '    mécaniquement à 0 %, ce qui ne veut PAS dire qu’elle est inutile. Mélange',
  '    les ères avant de conclure quoi que ce soit sur une bande.',
].join('\n');

async function main(): Promise<void> {
  const dossier = process.argv[2] ?? process.env['LOADTEST_CACHE'] ?? './.loadtest-cache';
  const limite = Number(process.argv[3] ?? 40);

  let fichiers: string[];
  try {
    fichiers = (await readdir(dossier))
      .filter((n) => /\.(jpe?g|png|webp|tiff?)$/i.test(n))
      .slice(0, limite);
  } catch {
    console.log(`\n  Dossier introuvable : ${dossier}`);
    console.log('  Donne-lui un dossier de scans, ou lance `pnpm loadtest 60` pour');
    console.log('  remplir le cache de renders officiels.\n');
    await closePool();
    return;
  }

  if (fichiers.length === 0) {
    console.log(`\n  Aucune image dans ${dossier}\n`);
    await closePool();
    return;
  }

  const ids = fichiers.map((f) => basename(f, extname(f)));
  const verite = await verites(ids);

  console.log(`\n  ${fichiers.length} images de ${dossier}`);
  console.log(
    verite.size > 0
      ? `  ${verite.size} avec un numéro connu du catalogue : la JUSTESSE est mesurable`
      : '  aucun nom de fichier ne correspond à une carte : seul le taux de lecture est mesurable',
  );

  const eres = await composition(ids);
  if (eres.length > 0) {
    console.log(`  composition : ${eres.map((e) => `${e.ere} ${e.n}`).join(' · ')}`);
    if (eres.length === 1) console.log(AVERTISSEMENT_UNE_ERE);
  }
  console.log('');

  const w = await createWorker('eng');
  const resultats: { g: Geometrie; lus: number; justes: number }[] = [];

  try {
    for (const g of GRILLE) {
      let lus = 0;
      let justes = 0;

      for (const [i, f] of fichiers.entries()) {
        let parsed: ReturnType<typeof parseNumberText> = null;
        try {
          const { data } = await w.recognize(await crop(await readFile(join(dossier, f)), g));
          if (data.confidence >= THRESHOLDS.ocr.minConfidence) {
            parsed = parseNumberText(data.text);
          }
        } catch {
          // Une image illisible ne fausse pas la comparaison : elle compte comme
          // non lue pour TOUTES les géométries.
        }

        if (parsed) {
          lus += 1;
          const attendu = verite.get(ids[i] as string);
          if (attendu !== undefined && parsed.number.toUpperCase() === attendu) justes += 1;
        }
      }

      resultats.push({ g, lus, justes });
      const pct = (n: number): string => `${Math.round((100 * n) / fichiers.length)} %`;
      console.log(
        `  ${g.nom.padEnd(22)} lus ${String(lus).padStart(3)} (${pct(lus).padStart(5)})` +
          (verite.size > 0 ? `   justes ${String(justes).padStart(3)} (${pct(justes)})` : ''),
      );
    }
  } finally {
    await w.terminate();
  }

  // Le classement se fait sur la JUSTESSE quand on la connaît. Un crop qui lit
  // beaucoup de mauvais numéros est pire qu'un crop qui ne lit rien : le
  // niveau 2 résoudrait vers la mauvaise carte avec une confiance élevée.
  const critere = verite.size > 0 ? 'justes' : 'lus';
  const classement = [...resultats].sort((a, b) => b[critere] - a[critere]);

  console.log(`\n  Classement sur « ${critere} » :`);
  for (const [i, r] of classement.slice(0, 3).entries()) {
    console.log(`    ${i + 1}. ${r.g.nom} — ${r[critere]} sur ${fichiers.length}`);
  }

  console.log(
    '\n  Ce script ne change AUCUN seuil. Toucher à THRESHOLDS.ocr.bands demande\n' +
      '  le golden set vert (skill card-matching-thresholds §1), qui est vide.\n',
  );

  await closePool();
}

void main();
