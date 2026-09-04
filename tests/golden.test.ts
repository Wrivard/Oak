import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { THRESHOLDS } from '../lib/config/thresholds.js';

/**
 * Porte de non-régression du matching. Voir le skill card-matching-thresholds §1.
 *
 * Aucun changement de seuil, de modèle ou de logique de résolution ne se merge
 * sans que ce fichier passe. Deux conditions, les deux doivent tenir :
 *   - la précision ne descend pas sous la ligne de base
 *   - le taux de review manuelle ne monte pas de plus de 2 points
 *
 * Le jeu de fixtures est VIDE tant que de vrais scans n'ont pas été étiquetés.
 * Le test passe quand même — mais il le dit, fort, plutôt que de laisser croire
 * que la porte est fermée. Constituer le jeu passe avant toute optimisation de
 * seuil.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golden');
const LABELS = join(FIXTURES, 'labels.json');

/** Taille en dessous de laquelle le jeu ne prouve rien (skill §1). */
const MIN_GOLDEN_SET = 200;

interface Label {
  sku: string;
  card_id: string;
  variant: string;
  condition: string;
}

type Labels = Record<string, Label>;

interface Baseline {
  precision: number;
  manualRate: number;
}

async function loadLabels(): Promise<Labels> {
  try {
    return JSON.parse(await readFile(LABELS, 'utf-8')) as Labels;
  } catch {
    return {};
  }
}

async function loadBaseline(): Promise<Baseline | null> {
  try {
    return JSON.parse(
      await readFile(join(FIXTURES, 'baseline.json'), 'utf-8'),
    ) as Baseline;
  } catch {
    return null;
  }
}

afterAll(async () => {
  await closePool();
});

describe('golden set — porte de non-régression du matching', () => {
  it('signale clairement si le jeu est trop petit pour prouver quoi que ce soit', async () => {
    const labels = await loadLabels();
    const n = Object.keys(labels).length;

    if (n < MIN_GOLDEN_SET) {
      // Volontairement pas un échec : à ce stade du build il n'existe aucun
      // scan réel. Mais il ne faut pas non plus se raconter que la porte tient.
      console.warn(
        `\n  ⚠ GOLDEN SET INSUFFISANT : ${n} scans étiquetés, minimum ${MIN_GOLDEN_SET}.\n` +
          `    La porte de non-régression du matching N'EST PAS ACTIVE.\n` +
          `    Ne touche pas aux seuils de lib/config/thresholds.ts tant que ce\n` +
          `    jeu n'est pas constitué — voir PROMPTS.md étape 1bis.\n`,
      );
    }
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it('mesure précision et taux de review dès que le jeu existe', async () => {
    const labels = await loadLabels();
    const ids = Object.keys(labels);
    if (ids.length === 0) return; // rien à mesurer, pas un échec

    const { rows } = await query<{
      id: string;
      status: string;
      match_source: string | null;
      resolved_sku: string | null;
    }>(
      `select id::text, status, match_source, resolved_sku
         from scans where id::text = any($1::text[])`,
      [ids],
    );

    const resolved = rows.filter((r) => r.status === 'resolved');
    const manual = rows.filter((r) => r.status === 'needs_review');
    const correct = resolved.filter((r) => r.resolved_sku === labels[r.id]?.sku);

    const precision = resolved.length === 0 ? 1 : correct.length / resolved.length;
    const manualRate = rows.length === 0 ? 0 : manual.length / rows.length;

    console.info(
      `\n  golden set : ${rows.length} scans | précision ${(precision * 100).toFixed(1)} % ` +
        `| review manuelle ${(manualRate * 100).toFixed(1)} %\n`,
    );

    const baseline = await loadBaseline();
    if (!baseline) {
      console.warn(
        '  ⚠ pas de baseline.json : la première exécution établit la ligne de base.\n',
      );
      return;
    }

    // Les deux conditions du skill §1.
    expect(precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(manualRate).toBeLessThanOrEqual(baseline.manualRate + 0.02);
  });
});

describe('seuils', () => {
  it('la marge minimum est strictement positive', () => {
    // Retirer la marge ferait passer pour un match tout premier candidat sous le
    // seuil absolu, y compris quand le deuxième est à 0,001 derrière. C'est ce
    // qui attrape les artworks réimprimés et les promos (skill §3).
    expect(THRESHOLDS.catalog.minMargin).toBeGreaterThan(0);
  });

  it('le budget du niveau 1 reste sous la séparation mesurée entre cartes', () => {
    // Mesuré sur 741 paires de cartes distinctes : la somme des deux distances
    // n'est jamais descendue sous 29 (docs/02 §3). Le budget doit rester
    // nettement en dessous, sinon le niveau 1 produit des faux positifs — et un
    // faux positif ici incrémente la mauvaise quantité en silence.
    const budget = THRESHOLDS.ownHistory.phashMax + THRESHOLDS.ownHistory.dhashMax;
    expect(budget).toBeLessThan(29);
  });

  it('le seuil de review dure est au-dessus du plafond d’auto-acceptation', () => {
    expect(THRESHOLDS.hardReview.minValue).toBeGreaterThan(
      THRESHOLDS.autoAccept.maxValue,
    );
  });
});
