import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotEnv, parseDotEnv } from '../lib/dotenv.js';

/**
 * Le chargement de `.env.local`.
 *
 * Next le charge tout seul ; le worker, non. Il lisait donc uniquement
 * l'environnement du process, et `Demarrer.bat` le lance dans un `cmd` neuf,
 * sans rien. Double-cliquer le lanceur démarrait un worker qui mourait aussitôt
 * sur « DATABASE_URL: Required », dans une fenêtre réduite que personne ne
 * regarde — pendant que l'application, elle, tournait parfaitement. On pouvait
 * envoyer un lot entier et attendre indéfiniment.
 */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pokelister-env-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseDotEnv', () => {
  it('lit des paires simples', () => {
    const m = parseDotEnv('A=1\nB=deux\n');
    expect(m.get('A')).toBe('1');
    expect(m.get('B')).toBe('deux');
  });

  it('NE CASSE PAS UNE URL POSTGRES', () => {
    // Le cas qui compte : mot de passe avec caractères spéciaux, port,
    // paramètres. Deviner est exclu — une URL mal découpée ferait échouer la
    // connexion avec un message qui n'aide pas.
    const url = 'postgresql://postgres.abc:Bon#Verre!321@aws-0.pooler.com:5432/postgres?sslmode=require';
    const m = parseDotEnv(`DATABASE_URL="${url}"\n`);
    expect(m.get('DATABASE_URL')).toBe(url);
  });

  it('ignore commentaires et lignes vides', () => {
    const m = parseDotEnv('# un commentaire\n\n  \nA=1\n#B=2\n');
    expect(m.get('A')).toBe('1');
    expect(m.has('B')).toBe(false);
    expect(m.size).toBe(1);
  });

  it('accepte le préfixe export', () => {
    expect(parseDotEnv('export A=1\n').get('A')).toBe('1');
  });

  it('retire les guillemets, simples comme doubles', () => {
    expect(parseDotEnv('A="x y"\n').get('A')).toBe('x y');
    expect(parseDotEnv("B='x y'\n").get('B')).toBe('x y');
  });

  it('coupe un commentaire de fin de ligne seulement hors guillemets', () => {
    expect(parseDotEnv('A=1 # note\n').get('A')).toBe('1');
    expect(parseDotEnv('B="1 # pas une note"\n').get('B')).toBe('1 # pas une note');
  });

  it('garde une valeur vide comme chaîne vide', () => {
    // `FOO=` est déclaré-mais-vide, ce que lib/env.ts traite spécifiquement.
    expect(parseDotEnv('A=\n').get('A')).toBe('');
  });
});

describe('loadDotEnv', () => {
  it('remplit ce qui manque', async () => {
    await writeFile(join(dir, '.env.local'), 'DATABASE_URL=postgres://x/y\nLOG_LEVEL=debug\n');
    const env: Record<string, string | undefined> = {};
    const ajoutees = loadDotEnv(dir, env);
    expect(env['DATABASE_URL']).toBe('postgres://x/y');
    expect(ajoutees).toContain('LOG_LEVEL');
  });

  it('L’ENVIRONNEMENT DU PROCESS GAGNE TOUJOURS', async () => {
    // `PG_POOL_MAX=2 pnpm worker` doit faire ce qu'il annonce, et en production
    // les vraies variables priment sur un fichier oublié sur le disque.
    await writeFile(join(dir, '.env.local'), 'DATABASE_URL=postgres://fichier/y\n');
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgres://process/y' };
    const ajoutees = loadDotEnv(dir, env);
    expect(env['DATABASE_URL']).toBe('postgres://process/y');
    expect(ajoutees).not.toContain('DATABASE_URL');
  });

  it('ne renvoie que des NOMS, jamais des valeurs', async () => {
    // Un fichier d'environnement contient un mot de passe de base : ce que
    // cette fonction rend peut finir dans un journal.
    await writeFile(join(dir, '.env.local'), 'SECRET=motdepasse\n');
    const ajoutees = loadDotEnv(dir, {});
    expect(ajoutees).toEqual(['SECRET']);
    expect(ajoutees.join()).not.toContain('motdepasse');
  });

  it('un fichier absent n’est pas une erreur', () => {
    // C'est le cas normal en production : les variables viennent de
    // l'environnement, pas d'un fichier.
    expect(() => loadDotEnv(join(dir, 'nexistepas'), {})).not.toThrow();
    expect(loadDotEnv(join(dir, 'nexistepas'), {})).toEqual([]);
  });

  it('.env.local prime sur .env', async () => {
    await writeFile(join(dir, '.env'), 'A=du-env\nB=seulement-env\n');
    await writeFile(join(dir, '.env.local'), 'A=du-local\n');
    const env: Record<string, string | undefined> = {};
    loadDotEnv(dir, env);
    expect(env['A']).toBe('du-local');
    expect(env['B']).toBe('seulement-env');
  });
});
