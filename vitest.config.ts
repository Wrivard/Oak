import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Le seed du catalogue est lent et les tests tapent une vraie base.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Balayage de fin : les jobs dont le scan a disparu. Voir le fichier, la
    // course est expliquée là-bas.
    globalSetup: ['tests/global-teardown.ts'],
    // Une seule connexion à la fois : les tests partagent la même base.
    fileParallelism: false,
    //
    // ILS LA PARTAGENT AUSSI AVEC LE WORKER. Le lanceur en garde un en marche
    // en permanence, et il a le droit de réclamer un job ou de faire avancer un
    // scan entre l'insertion d'un test et son assertion.
    //
    // Conséquence pour qui écrit un test ici : n'affirme jamais un statut
    // TRANSITOIRE — `queued`, `pending`, `fingerprinted`. Affirme ce que la
    // fonction promet : la ligne existe, son type est le bon, son contenu est
    // le bon. Deux tests ont échoué de cette façon, et ils échouaient sur une
    // machine où l'application tourne, c'est-à-dire dans le cas normal.
    //
    // Un statut FINAL — `rejected`, `resolved`, `dead` — reste vérifiable : le
    // worker ne les fait pas repartir en arrière.
    //
    // ET IL FAUT DE LA PLACE DANS LE POOLER. Le pooler de session Supabase
    // plafonne à quinze clients TOUS PROCESSUS CONFONDUS. Le lanceur en tient
    // déjà dix — cinq pour l'application, cinq pour le worker. La suite ouvre
    // les siens par-dessus, et les tests de concurrence, qui lancent dix
    // appels simultanés, sont les premiers à s'y casser :
    // `EMAXCONNSESSION` remonte en échec de test sans rapport avec ce qui est
    // testé. Observé deux fois pendant une session où un second serveur de
    // développement tournait à côté.
    //
    // Avant de conclure qu'un test de concurrence est cassé : compter les
    // process Node qui parlent à la base, ou lancer le serveur de mise au
    // point avec `PG_POOL_MAX=2`.
  },
});
