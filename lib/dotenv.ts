import { readFileSync } from 'node:fs';

/**
 * Charge `.env.local` dans `process.env`.
 *
 * POURQUOI ÇA EXISTE. Next charge `.env.local` tout seul ; le worker, non. Il
 * lisait donc uniquement l'environnement du process, et `Demarrer.bat` le lance
 * dans un `cmd` neuf, sans rien. Résultat : double-cliquer le lanceur démarrait
 * un worker qui mourait immédiatement sur « DATABASE_URL: Required », dans une
 * fenêtre réduite que personne ne regarde. L'application, elle, démarrait très
 * bien — on pouvait donc envoyer un lot entier et attendre indéfiniment que
 * quelque chose se passe.
 *
 * Écrit à la main plutôt qu'avec une dépendance : c'est vingt lignes, et le
 * projet n'ajoute pas un paquet pour ça.
 *
 * RÈGLE : l'environnement du process GAGNE toujours. `PG_POOL_MAX=2 pnpm worker`
 * doit continuer de faire ce qu'il annonce, et en production les vraies
 * variables d'environnement priment sur un fichier oublié sur le disque.
 */
const FICHIERS = ['.env.local', '.env'] as const;

/** Le nom d'une variable, tel qu'on l'écrit dans un fichier d'environnement. */
const LIGNE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function decoupe(contenu: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const brute of contenu.split(/\r?\n/)) {
    const ligne = brute.trim();
    if (ligne === '' || ligne.startsWith('#')) continue;

    const m = LIGNE.exec(ligne);
    if (!m) continue;
    const cle = m[1];
    let valeur = (m[2] ?? '').trim();
    if (cle === undefined) continue;

    // Guillemets : on les retire, et seulement à l'intérieur d'eux un `#` ne
    // commence pas un commentaire. Une URL Postgres contient des caractères
    // qui n'aiment pas être devinés.
    const guillemet = valeur[0];
    if ((guillemet === '"' || guillemet === "'") && valeur.endsWith(guillemet) && valeur.length > 1) {
      valeur = valeur.slice(1, -1);
    } else {
      const diese = valeur.indexOf(' #');
      if (diese >= 0) valeur = valeur.slice(0, diese).trim();
    }

    out.set(cle, valeur);
  }
  return out;
}

/**
 * Renvoie les clés effectivement ajoutées. Jamais les valeurs : un fichier
 * d'environnement contient un mot de passe de base de données.
 */
export function loadDotEnv(
  cwd = process.cwd(),
  // `Record` plutôt que `NodeJS.ProcessEnv` : Next augmente ce type pour rendre
  // `NODE_ENV` obligatoire, ce qui interdirait de passer un environnement vide
  // — exactement ce qu'un test doit pouvoir faire.
  env: Record<string, string | undefined> = process.env,
): string[] {
  const ajoutees: string[] = [];

  for (const nom of FICHIERS) {
    let contenu: string;
    try {
      contenu = readFileSync(`${cwd}/${nom}`, 'utf-8');
    } catch {
      // Absent : c'est le cas normal en production, où les variables viennent
      // de l'environnement.
      continue;
    }

    for (const [cle, valeur] of decoupe(contenu)) {
      if (env[cle] !== undefined) continue;
      env[cle] = valeur;
      ajoutees.push(cle);
    }
  }

  return ajoutees;
}

/** Réservé aux tests. */
export const parseDotEnv = decoupe;
