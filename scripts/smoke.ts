/**
 * Rendu réel de chaque page, contre la base telle qu'elle est.
 *
 * Pourquoi ce script existe : `/pricing` a renvoyé 500 pendant deux étapes
 * complètes. Le build était vert. J'avais vérifié que la page COMPILAIT sans
 * jamais la CHARGER — un `ntile()` imbriqué que Postgres refuse ne se voit pas
 * à la compilation. Un build vert n'est pas une page rendue.
 *
 * Deux états comptent et se testent séparément :
 *   - base VIDE, l'état d'un lundi matin. Une page qui plante sur zéro ligne
 *     est la première chose qu'on voit en arrivant.
 *   - base PLEINE, l'état de tous les autres jours.
 *
 * Usage : pnpm smoke [base-url]
 * Sans argument, démarre le serveur de prod lui-même sur un port libre.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const NEXT_BIN = createRequire(import.meta.url).resolve('next/dist/bin/next');

const ROUTES = [
  '/',
  '/upload',
  '/batches',
  '/review',
  '/audit',
  '/inventory',
  '/pricing',
  '/diagnostics',
  '/dashboard',
] as const;

/**
 * Un 200 peut cacher une page morte : le routeur app de Next sert sa frontière
 * d'erreur avec le même code que la page. Deux vérifications, dans cet ordre.
 *
 * NÉGATIVE — le texte de notre propre `app/error.tsx`, celui qu'on voit quand
 * une requête SQL explose. Ne pas chercher « This page could not be found » :
 * Next embarque ce libellé dans le bundle de TOUTES les pages, ce qui faisait
 * échouer les neuf d'un coup, y compris celles qui allaient bien.
 *
 * POSITIVE — la coquille. Une page qui rend vraiment porte la barre latérale.
 * Sans ça, une page blanche à 200 passerait pour un succès.
 */
const ERROR_MARKERS = [
  'Cette page n’a pas pu se charger',
  'Internal Server Error',
];
const SHELL_MARKER = 'class="shell"';

interface Result {
  route: string;
  status: number;
  ms: number;
  bytes: number;
  probleme?: string;
}

async function check(base: string, route: string): Promise<Result> {
  const t0 = Date.now();
  try {
    // Timeout explicite : une page qui ne répond JAMAIS est un échec, pas une
    // raison de suspendre le script indéfiniment. C'est ce qui est arrivé.
    const res = await fetch(base + route, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    const ms = Date.now() - t0;
    const marker = ERROR_MARKERS.find((m) => body.includes(m));
    return {
      route,
      status: res.status,
      ms,
      bytes: body.length,
      ...(res.status >= 400
        ? { probleme: `HTTP ${res.status}` }
        : marker
          ? { probleme: `frontière d'erreur : « ${marker} »` }
          : !body.includes(SHELL_MARKER)
            ? { probleme: 'coquille absente — la page n’a pas rendu' }
            : {}),
    };
  } catch (err) {
    return { route, status: 0, ms: Date.now() - t0, bytes: 0, probleme: String(err) };
  }
}

async function waitFor(base: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(base + '/', { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`serveur injoignable sur ${base} après ${timeoutMs / 1000}s`);
}

/**
 * `.next` contient-il un build de production UTILISABLE ?
 *
 * Deux façons de ne pas en avoir, et elles ne se disent pas pareil :
 *
 *  - il n'y a jamais eu de build. `BUILD_ID` manque.
 *  - il y en a eu un, mais `next dev` a tourné depuis et a réécrit une partie
 *    des fichiers par-dessus. `BUILD_ID` est toujours là, le build est mort.
 *    C'est le cas courant après une session de mise au point : `next start`
 *    meurt alors sur un `Cannot find module './vendor-chunks/…'` de quarante
 *    lignes suivi de neuf pages en 500 — un diagnostic qui ressemble à une
 *    application cassée alors qu'il manque seulement une commande.
 *
 * Le marqueur du second cas est `.next/static/development`, que seul le mode
 * dev crée.
 */
type EtatBuild = 'ok' | 'absent' | 'ecrase-par-dev';

async function etatDuBuild(): Promise<EtatBuild> {
  for (const f of ['.next/BUILD_ID', '.next/routes-manifest.json']) {
    try {
      await readFile(f);
    } catch {
      return 'absent';
    }
  }
  try {
    await stat('.next/static/development');
    return 'ecrase-par-dev';
  } catch {
    return 'ok';
  }
}

async function main(): Promise<void> {
  const given = process.argv[2];
  let child: ChildProcess | undefined;
  let base = given ?? '';

  if (!given) {
    // `next dev` et `next build` partagent `.next`. Après une session de dev,
    // il n'y a plus de build de production dedans et `next start` meurt sur un
    // MODULE_NOT_FOUND de quarante lignes, suivi de neuf pages en 500 — un
    // diagnostic qui ressemble à une application cassée alors qu'il manque
    // seulement une commande.
    const etat = await etatDuBuild();
    if (etat !== 'ok') {
      console.error('');
      console.error(
        etat === 'absent'
          ? '  Pas de build de production dans .next.'
          : '  Le build de .next a été écrasé par `next dev`.',
      );
      console.error('  Arrête le serveur de dev, puis relance `pnpm build`.');
      console.error('');
      process.exitCode = 1;
      return;
    }

    const port = 3200 + Math.floor(Math.random() * 400);
    base = `http://127.0.0.1:${port}`;
    // On lance `next` par son point d'entrée Node, pas par `node_modules/.bin/next`
    // ni par `pnpm exec` : sous Windows le premier est un script shell que spawn
    // ne sait pas exécuter, et le second ajoute un intermédiaire qu'un kill ne
    // traverse pas — le serveur survivait au script et le laissait pendu.
    child = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(port)], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env },
    });
  }

  try {
    await waitFor(base);

    const results: Result[] = [];
    // En série : mesurer une latence pendant que huit autres requêtes tapent le
    // même pool de 5 connexions ne mesurerait que la contention.
    for (const route of ROUTES) results.push(await check(base, route));

    const w = Math.max(...results.map((r) => r.route.length));
    console.log('');
    for (const r of results) {
      const ok = r.probleme ? 'ECHEC' : ' ok  ';
      console.log(
        `  ${ok}  ${r.route.padEnd(w)}  ${String(r.status).padStart(3)}  ` +
          `${String(r.ms).padStart(5)} ms  ${String(Math.round(r.bytes / 1024)).padStart(4)} Ko` +
          (r.probleme ? `   ${r.probleme}` : ''),
      );
    }

    const echecs = results.filter((r) => r.probleme);
    const lent = results.filter((r) => !r.probleme && r.ms > 1500);
    console.log('');
    if (lent.length > 0) {
      console.log(`  ${lent.length} page(s) au-dessus de 1,5 s : ${lent.map((r) => r.route).join(', ')}`);
    }
    if (echecs.length > 0) {
      console.log(`  ${echecs.length} page(s) en échec sur ${results.length}.`);
      process.exitCode = 1;
    } else {
      console.log(`  ${results.length} pages rendues, aucune en échec.`);
    }
  } finally {
    child?.kill();
  }
}

void main();
