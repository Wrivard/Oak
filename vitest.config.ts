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
  },
});
