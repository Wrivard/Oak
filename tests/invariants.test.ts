import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Les invariants de `CLAUDE.md`, vérifiés sur le code plutôt que sur parole.
 *
 * Ce fichier est inhabituel : il lit les sources au lieu d'exécuter des
 * fonctions. C'est délibéré. `CLAUDE.md` énonce des règles dont la violation ne
 * casse aucun test — elle change simplement, en silence, ce que le système fait
 * ou ce qu'il coûte. Un appel à l'API Claude depuis le code d'une app payée par
 * abonnement ne casse rien : il facture. Un appel externe dans une requête HTTP
 * ne casse rien : il fait expirer la requête un jour de lenteur réseau.
 *
 * Ces règles-là méritent une porte, pas une relecture.
 */
const RACINES = ['lib', 'worker', 'app', 'scripts'];

interface Fichier {
  chemin: string;
  contenu: string;
}

async function sources(): Promise<Fichier[]> {
  const out: Fichier[] = [];

  async function descendre(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await descendre(p);
      } else if (/\.tsx?$/.test(e.name)) {
        out.push({
          chemin: relative('.', p).replace(/\\/g, '/'),
          contenu: await readFile(p, 'utf-8'),
        });
      }
    }
  }

  for (const r of RACINES) await descendre(r);
  return out;
}

/** Le fichier déclare-t-il tourner dans le navigateur ? */
const estClient = (f: Fichier): boolean => /^['"]use client['"]/m.test(f.contenu);

/**
 * Le code sans ses commentaires.
 *
 * Indispensable ici : ce fichier cherche des motifs qui sont AUSSI cités dans
 * les commentaires du projet. `lib/log.ts` explique la règle « jamais de catch
 * vide » en la citant, et la citation faisait échouer le test.
 */
function codeSeul(f: Fichier): string {
  return f.contenu.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Le code avec chaque commentaire remplacé par un JALON, pas supprimé.
 *
 * Pour la règle du catch vide, la nuance décide de tout. Un catch qui ne
 * contient QU’UN commentaire prend une décision explicite et documentée :
 * c'est la pratique du projet, elle est permise. Le supprimer le ferait passer
 * pour vide. Et garder le texte brut ferait échouer sur les commentaires qui
 * CITENT la règle. Un jalon règle les deux — le catch commenté devient non
 * vide, et la citation disparaît avec son commentaire.
 */
function codeAvecJalons(f: Fichier): string {
  return f.contenu
    .replace(/\/\*[\s\S]*?\*\//g, 'JALON;')
    .replace(/\/\/[^\n]*/g, 'JALON;');
}

const fichiers = await sources();

describe('les invariants de CLAUDE.md tiennent dans le code', () => {
  it('le code compte', () => {
    // Garde-fou du fichier lui-même : si la collecte tombait à zéro, tous les
    // tests ci-dessous passeraient en ne vérifiant rien.
    expect(fichiers.length).toBeGreaterThan(40);
  });

  it('AUCUN APPEL À L’API CLAUDE — l’abonnement est déjà payé', () => {
    // Un SDK Anthropic dans le code d'une app facturerait des crédits en double
    // de l'abonnement. Ça ne casse rien : ça coûte.
    for (const f of fichiers) {
      const code = codeSeul(f);
      expect(code, f.chemin).not.toMatch(/@anthropic-ai\/sdk/);
      expect(code, f.chemin).not.toMatch(/ANTHROPIC_API_KEY/);
    }
  });

  it('AUCUN APPEL EXTERNE DEPUIS UNE REQUÊTE HTTP (invariant 4)', () => {
    // Côté serveur dans `app/`, un `fetch` vers un hôte externe fait dépendre le
    // temps de réponse d'un tiers. Tout passe par la queue. Les composants
    // client, eux, ont le droit d'appeler nos propres routes.
    const serveur = fichiers.filter((f) => f.chemin.startsWith('app/') && !estClient(f));
    expect(serveur.length).toBeGreaterThan(10);
    for (const f of serveur) {
      expect(codeSeul(f), f.chemin).not.toMatch(/fetch\(\s*['"`]https?:/);
    }
  });

  it('UNE LIGNE D’INVENTAIRE NE SE SUPPRIME JAMAIS (invariant 7)', () => {
    // Une quantité à zéro reste à zéro : les empreintes et l'historique y font
    // référence. Seuls les scripts d'effacement volontaire ont le droit.
    const autorises = ['scripts/reset-data.ts', 'scripts/seed-volume.ts'];
    for (const f of fichiers) {
      if (autorises.includes(f.chemin)) continue;
      expect(codeSeul(f).toLowerCase(), f.chemin).not.toMatch(/delete\s+from\s+inventory/);
    }
  });

  it('UN SEUL CONSTRUCTEUR DE SKU (invariant 8)', () => {
    // Le SKU est une clé primaire et une clé d'appariement TCGplayer. Le jour où
    // le format change, il doit changer à un seul endroit.
    for (const f of fichiers) {
      if (f.chemin === 'lib/sku.ts') continue;
      expect(codeSeul(f), f.chemin).not.toMatch(/\$\{\s*variant\s*\}-\$\{\s*condition\s*\}/);
    }
  });

  it('JAMAIS DE catch VIDE', () => {
    // Une erreur avalée sans trace est une panne qu'on ne verra pas. Un catch
    // commenté qui prend une décision explicite reste permis — c'est le vide
    // TOTAL, sans code ni explication, qui est interdit.
    for (const f of fichiers) {
      expect(codeAvecJalons(f), f.chemin).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
    }
  });

  it('NI `any`, NI ASSERTION NON-NULL dans le code applicatif', () => {
    // Les deux masquent exactement ce que `strict` sert à révéler. Les tests y
    // ont droit — ils fabriquent leurs propres données et savent ce qu'elles
    // contiennent.
    for (const f of fichiers) {
      const code = codeSeul(f);
      expect(code, `${f.chemin} : any`).not.toMatch(/:\s*any\b/);
      expect(code, `${f.chemin} : assertion non-null`).not.toMatch(/\w!\s*[.);,]/);
    }
  });

  it('les montants d’argent ne passent jamais par parseFloat', () => {
    // La porte d'entrée des erreurs de demi-cent qui, répétées 15 000 fois,
    // cessent d'être des arrondis.
    for (const f of fichiers) {
      if (!/pricing|net|inventory|money/i.test(f.chemin)) continue;
      expect(codeSeul(f), f.chemin).not.toMatch(/parseFloat\s*\(/);
    }
  });
});
