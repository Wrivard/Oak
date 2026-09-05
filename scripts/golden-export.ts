/**
 * Constitue le golden set à partir des résolutions déjà confirmées.
 *
 *   pnpm golden:export            → écrit tests/fixtures/golden/labels.json
 *   pnpm golden:baseline          → fige la ligne de base actuelle
 *
 * L'idée : **chaque confirmation manuelle est un exemple étiqueté**. Un humain a
 * regardé la carte et a dit quel SKU c'était — c'est exactement ce dont le
 * golden set a besoin, et ça existe déjà en base.
 *
 * Le skill card-matching-thresholds §1 exige 200 scans étiquetés avant de
 * toucher au moindre seuil. Ce script est le chemin pour y arriver sans travail
 * supplémentaire : il suffit de reviewer.
 *
 * Ce qu'il N'inclut PAS, et pourquoi :
 *   - les résolutions `catalog` et `own_history` non revues. Elles sont l'avis
 *     de la machine, pas une vérité terrain. Les inclure reviendrait à noter sa
 *     propre copie : le golden set confirmerait toujours ce que le système fait
 *     déjà, y compris ses erreurs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, query } from '../lib/db.js';
import { log } from '../lib/log.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'golden');
const LABELS = join(DIR, 'labels.json');
const BASELINE = join(DIR, 'baseline.json');

interface Label {
  sku: string;
  card_id: string;
  variant: string;
  condition: string;
  confirmed_at: string;
}

async function exportLabels(): Promise<number> {
  const { rows } = await query<{
    id: string;
    resolved_sku: string;
    card_id: string;
    variant: string;
    condition: string;
    resolved_at: string;
  }>(
    `select s.id::text, s.resolved_sku, i.card_id,
            i.variant::text, i.condition::text,
            to_char(s.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') as resolved_at
       from scans s
       join inventory i on i.sku = s.resolved_sku
      where s.status = 'resolved'
        and s.match_source = 'manual'
        and s.resolved_sku is not null
      order by s.resolved_at`,
  );

  // Fusion avec l'existant : un scan déjà étiqueté ne doit pas disparaître
  // parce qu'il a été purgé de la base entre-temps.
  let existing: Record<string, Label> = {};
  try {
    existing = JSON.parse(await readFile(LABELS, 'utf-8')) as Record<string, Label>;
  } catch {
    // premier export
  }

  for (const r of rows) {
    existing[r.id] = {
      sku: r.resolved_sku,
      card_id: r.card_id,
      variant: r.variant,
      condition: r.condition,
      confirmed_at: r.resolved_at,
    };
  }

  await mkdir(DIR, { recursive: true });
  await writeFile(LABELS, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');

  const total = Object.keys(existing).length;
  log.info('golden set exporté', {
    nouveaux: rows.length,
    total,
    suffisant: total >= 200,
  });

  if (total < 200) {
    log.warn(
      'golden set encore insuffisant : la porte de non-régression du matching ' +
        'reste INACTIVE tant qu’on n’a pas 200 scans étiquetés',
      { total, manquants: 200 - total },
    );
  }
  return total;
}

/**
 * Fige la ligne de base.
 *
 * À n'appeler que quand on est SATISFAIT du comportement courant : c'est ce
 * chiffre que les changements futurs devront égaler ou battre. Le figer sur un
 * système dégradé grave la dégradation dans le marbre.
 */
async function writeBaseline(): Promise<void> {
  const labels = JSON.parse(await readFile(LABELS, 'utf-8')) as Record<string, Label>;
  const ids = Object.keys(labels);
  if (ids.length === 0) throw new Error('aucun label : lance d’abord pnpm golden:export');

  const { rows } = await query<{
    status: string;
    resolved_sku: string | null;
    id: string;
  }>(
    `select id::text, status, resolved_sku from scans where id::text = any($1::text[])`,
    [ids],
  );

  const resolved = rows.filter((r) => r.status === 'resolved');
  const manual = rows.filter((r) => r.status === 'needs_review');
  const correct = resolved.filter((r) => r.resolved_sku === labels[r.id]?.sku);

  const baseline = {
    precision: resolved.length === 0 ? 1 : correct.length / resolved.length,
    manualRate: rows.length === 0 ? 0 : manual.length / rows.length,
    n: rows.length,
    figee_le: new Date().toISOString(),
  };

  await writeFile(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  log.info('ligne de base figée', baseline);
}

async function main(): Promise<void> {
  if (process.argv[2] === 'baseline') {
    await writeBaseline();
    return;
  }
  await exportLabels();
}

main()
  .catch((err: unknown) => {
    log.error('export du golden set échoué', { err });
    process.exitCode = 1;
  })
  .finally(() => closePool());
