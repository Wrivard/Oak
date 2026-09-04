# PROMPTS.md — séquence de build

Un prompt par session Claude Code. **Ne les fusionne pas.** Chaque étape doit tourner et
être vérifiée avant la suivante, sinon tu debugges cinq couches à la fois.

Colle le prompt tel quel. Claude Code lit `CLAUDE.md` automatiquement ; les docs
référencées sont dans `docs/`.

---

## Étape 0 — Expérience foil (PAS DE CODE)

> Ceci n'est pas une tâche de développement. Fais-la toi-même, à la main, avant tout.

1. Scanne 50 reverse holos et 50 normaux de la même ère, avec tes réglages PaperStream
   définitifs.
2. Ouvre-les côte à côte à 100 %. Peux-tu distinguer les deux à l'œil sur le scan ?
3. Calcule la variance de luminance sur la zone d'artwork des deux groupes. Y a-t-il une
   séparation nette ?

**Décision.** Séparation nette → tu pourras détecter le variant automatiquement plus tard.
Pas de séparation → le pré-tri physique et `sessions.default_variant` sont définitifs, et
tu n'essaies jamais de classifier le foil. Note le résultat dans `docs/experiments.md`.

---

## Étape 1 — Expérience comps (PAS DE CODE)

> Toujours pas de développement.

1. Crée un compte tcgapi.net, tier gratuit.
2. Choisis 20 cartes dont tu connais la valeur réelle (5 bulk, 10 mid, 5 chères).
3. Appelle `/v1/comps` pour chacune. Compare aux ventes eBay réelles que tu vois toi-même.
4. Note : nombre de comps retournés, écart médian vs réalité, cartes sans données.

**Décision.** Écart médian sous 15 % et au moins 3 comps sur la majorité → tcgapi.net est
ta source. Sinon, teste pokemonpricetracker en second. Si les deux déçoivent, le pricing
tourne sur TCGplayer market seul et tu ajustes les poids dans `docs/03-pricing.md`.

---

## Étape 2 — Fondations et catalogue

```
Lis CLAUDE.md et docs/01-architecture-and-data-model.md.

Initialise le projet:
- Next.js 15 App Router, TypeScript strict, pnpm
- Supabase local (supabase init + supabase start)
- Applique les migrations 001 à 006 telles qu'écrites dans le doc, une par fichier
  numéroté dans supabase/migrations/
- Un process worker séparé dans worker/, avec un tsconfig distinct

Puis écris scripts/seed-catalog.ts:
- Télécharge les dumps JSON de github.com/PokemonTCG/pokemon-tcg-data
- Upsert dans `cards`. Attends ~20-31k cartes anglaises.
- Idempotent: relançable sans doublons.
- Log le compte final par set, et échoue si le total est sous 15000.

Vérifie ensuite que ces requêtes retournent le bon résultat, et écris-les comme tests:
- Charizard Base Set: where printed_total=102 and number='4' → exactement 1 ligne
- Un secret rare moderne où number > printed_total → trouvé via `total`
- Une promo type SWSH284 → trouvée sans dénominateur

Ne code rien d'autre. Pas d'UI, pas de worker, pas d'API.
```

---

## Étape 3 — Empreintes et embeddings

```
Lis docs/02-ingest-and-matching.md sections 3 et 4.

Implémente lib/fingerprint/:
- phash(buffer): bit(64) — grayscale, 32×32, DCT-II, coin 8×8 basse fréquence, médiane
- dhash(buffer): bit(64) — 9×8, comparaison horizontale
- embed(buffer): number[512] — @xenova/transformers, Xenova/clip-vit-base-patch32,
  normalisé L2

Puis scripts/seed-embeddings.ts: calcule l'embedding de card.image_small pour toutes
les cartes, écrit dans card_embeddings avec model='clip-vit-base-patch32'.
Reprend où il s'est arrêté si interrompu. Traite par lots de 100.

Tests obligatoires:
- La même image donne le même hash de façon déterministe
- Une image redimensionnée à 80% garde une distance de Hamming ≤ 4
- Deux cartes différentes ont une distance de Hamming ≥ 20
- Un embedding a bien une norme de 1.0

Vérifie que l'index HNSW est utilisé: EXPLAIN ANALYZE sur une requête de similarité
doit montrer un Index Scan, pas un Seq Scan.
```

---

## Étape 4 — Ingestion

```
Lis docs/02-ingest-and-matching.md sections 1 et 7.

Implémente worker/ingest/:
- watcher.ts: chokidar avec awaitWriteFinish, ignoreInitial:false
- Parse {session}_{seq}_{side}.jpg, insère dans `scans`, enqueue un job `fingerprint`,
  déplace le fichier vers processed/{session}/
- Aucun traitement d'image ici

Implémente worker/queue/:
- claim(type): la requête UPDATE ... FOR UPDATE SKIP LOCKED du doc, exactement
- complete(id), fail(id, err) avec backoff exponentiel 2^attempts * 10s
- Boucle de worker avec concurrence configurable par type
- Arrêt propre sur SIGTERM: finit les jobs en cours, n'en prend pas de nouveaux

Implémente le handler `fingerprint`: hash + embed, écrit dans scans, enqueue `match`.

Tests:
- Deux workers en parallèle ne prennent jamais le même job (test avec 100 jobs, 4 workers)
- Un crash à mi-parcours ne perd aucun scan au redémarrage
- Un fichier réécrit deux fois ne crée qu'une ligne (contrainte unique session+seq)
```

---

## Étape 5 — Matching

```
Lis docs/02-ingest-and-matching.md section 4 en entier.

Implémente le handler `match` avec les trois niveaux dans l'ordre exact du doc.
Les seuils viennent de lib/config/thresholds.ts, jamais en dur ailleurs.

Points d'attention:
- Le niveau 2 exige la marge minimum entre 1er et 2e candidat, pas juste le seuil absolu
- variant_conflict force needs_review peu importe la confiance
- Un match résolu vers un SKU existant appelle apply_qty_delta(+1), il ne fait pas
  d'UPDATE direct sur qty_on_hand
- Un nouveau SKU est créé avec qty 0 puis apply_qty_delta(+1)

N'implémente PAS encore le niveau 3 (LLM). Les scans qui l'atteindraient vont en
needs_review avec match_source null. On veut mesurer le taux avant de payer pour lui.

Écris le harnais golden set: tests/golden.test.ts qui charge
tests/fixtures/golden/labels.json et vérifie précision + taux de fallback.
Le fichier de fixtures peut être vide au début, le test doit passer quand même.
```

---

## Étape 6 — UI de review

```
Lis docs/02-ingest-and-matching.md section 4 et docs/03-pricing.md section 4.

Une seule page: /review

- Grille des scans en needs_review, la plus dense possible
- Par carte: image à gauche, données éditables à droite
- Dropdown variant qui recalcule le prix en direct (l'erreur la plus coûteuse)
- Selector de condition avec impact prix visible
- Les 3 sources de prix côte à côte avec n_comps
- net_after_fees affiché en permanence
- Champ prix final pré-rempli avec la suggestion

Raccourcis clavier obligatoires: A accept, E edit, X skip, flèches navigation.
Optimise pour 3 secondes par carte. Chaque clic de souris nécessaire est un bug.

Alerte prix: son configurable + bordure colorée quand la valeur dépasse des paliers.

Toute confirmation écrit dans known_fingerprints avec confirmed_by='manual'.
C'est le mécanisme qui rend le système gratuit — ne l'oublie pas.

Aucun appel API externe depuis une route Next.js. Tout passe par jobs.
```

---

## Étape 7 — Pricing

```
Lis docs/03-pricing.md en entier.

Implémente lib/pricing/:
- sources.ts: pokemontcg.io + la source de comps validée à l'étape 1
- estimate.ts: estimateValue avec médiane et trim IQR
- rules.ts: suggestPrice avec les bandes depuis pricing_rules
- fees.ts: netAfterFees

Handler `price_refresh` + cron horaire selon la requête du doc, limit 500.

Garde-fous NON NÉGOCIABLES:
- method='no_data' ne produit jamais de prix, il envoie en review
- Un mouvement > 40% en un cycle est flaggé et non poussé
- market null est géré partout avec fallback, jamais de crash

Tests unitaires avant toute intégration: les 5 lignes du tableau de bandes du doc,
plus valeur null, valeur négative, valeurs exactement sur les frontières de bandes.
Ces tests bloquent le merge.

Écris une petite UI d'édition de pricing_rules.config avec preview en direct sur
20 SKUs réels et net_after_fees affiché.
```

---

## Étape 8 — Fallback LLM

```
Lis docs/02-ingest-and-matching.md section 5.

Maintenant qu'on connaît le vrai taux de fallback (regarde la métrique de l'étape 5),
implémente le niveau 3 avec la Message Batches API — pas l'API synchrone.

- Job `llm_batch_flush` aux 30 min: ramasse les scans en attente, soumet un lot
  (max 10000 requêtes), stocke le batch_id. custom_id = scan_id.
- Job `llm_batch_poll`: sonde, draine les résultats, applique.
- Utilise tool use pour forcer le JSON, pas une instruction dans le prompt.
- Valide chaque réponse avec Zod. Un échec de validation → needs_review, jamais
  d'application partielle.
- Prompt caching 1 heure sur le contexte partagé.
- Tout résultat confirmé écrit dans known_fingerprints avec confirmed_by='llm'.

Ajoute au dashboard: coût cumulé du mois, taux de fallback sur 7 jours glissants.
```

---

## Étape 9 — eBay

```
Lis docs/04-channels.md partie A EN ENTIER avant de coder. Il y a trois pièges
documentés qui vont te coûter une journée chacun si tu les rates.

Ordre d'implémentation:
1. OAuth avec refresh proactif et alerte à J-30
2. Un helper unique updateInventoryItem(sku, patch) qui fait GET puis merge.
   AUCUN autre code n'appelle bulkCreateOrReplaceInventoryItem directement.
3. Cache des aspects par catégorie, TTL 7 jours, via Taxonomy API
4. canPublish(sku): valide TOUS les champs requis à la publication avant d'enqueue
5. Upload EPS, 4-6 en parallèle, idempotent via hero_image_url
6. Les trois handlers bulk, 25 items par appel
7. Polling getOrders aux 15 min, idempotency_key = orderId:lineItemId
8. Job de réconciliation quotidien avec alerte sur écart

Développe tout contre le sandbox eBay. Avant la production: 10 cartes réelles publiées
à la main via le pipeline, vérifiées visuellement sur le site, puis seulement on ouvre.

Test de génération de titre sur 500 cartes du catalogue: aucun > 80 caractères,
aucun ne perd le numéro.
```

---

## Étape 10 — TCGplayer

```
Lis docs/04-channels.md parties B et C.

AVANT DE CODER, vérifie deux choses dans ton compte vendeur:
1. As-tu le statut Level 4 Seller? Sans lui, l'import/export CSV de masse est
   indisponible et cette étape entière est bloquée.
2. Le minimum de 0.40$ sur les listings Direct s'applique-t-il à ton setup?

Si l'une des deux bloque, arrête et dis-le. Ne construis pas autour.

Ensuite:
1. Seed one-shot de inventory.tcg_sku_id depuis un Export Filtered CSV par ligne
   de produit Pokémon. Sans ce mapping rien ne fonctionne.
   Vérifie que chaque {card_id, variant, condition} mappe vers exactement un tcg_sku_id.
   Tout écart révèle un bug dans le découpage de SKU — remonte-le.
2. allocate() selon la partie C
3. Génération du CSV: la colonne quantité est un DELTA depuis tcg_qty_pushed,
   PAS la valeur absolue. Relis le doc, c'est le bug qui corrompt l'inventaire.
4. tcg_qty_pushed mis à jour SEULEMENT après confirmation d'import réussi.
5. Commence par le CSV manuel assisté. Pas de Playwright tant que le manuel n'est
   pas fiable pendant deux semaines.

Test obligatoire: séquence push(qty 8) → vente(2) → push. Le second delta doit être
-2, pas 6, pas 8.
```

---

## Étape 11 — Production

```
Lis docs/05-production.md en entier et implémente tout ce qui manque:

- Logs structurés JSON avec scan_id/session_id/sku sur chaque ligne
- Le dashboard 5 métriques avec les seuils d'alarme du doc
- classifyError() avec ses tests
- Circuit breaker par service externe
- Redacteur de logs qui masque les tokens
- Backup quotidien de known_fingerprints et inventory, avec un script de restauration
  QUE TU TESTES pour de vrai
- Test de charge: 2000 scans synthétiques, mesure débit / queue / mémoire sur 1h

Puis écris docs/runbooks.md à partir de la section 6 du doc, en l'ajustant à ce que
le système fait vraiment maintenant.

Ajoute enfin la section "Ce que ce système ne fera jamais" (§7) dans CLAUDE.md pour
que les futures sessions ne dérivent pas.
```

---

## Ce que tu mesures après chaque étape

| Après | Chiffre à noter |
|---|---|
| 2 | cartes seedées, requêtes de matching correctes |
| 3 | temps d'embedding par carte, taille de l'index HNSW |
| 4 | débit du pipeline en cartes/minute |
| 5 | **répartition own_history / catalog / non-résolu** |
| 6 | secondes par carte en review |
| 7 | écart entre prix suggéré et ton jugement sur 50 cartes |
| 8 | taux de fallback LLM, coût réel du mois |
| 9 | temps de publication bout en bout, taux d'échec |
| 10 | SKUs mappés vers TCGplayer, écarts détectés |

Le chiffre de l'étape 5 est le plus important du projet. S'il montre 60 % de non-résolu
après ton seed de 2 000 cartes, quelque chose ne va pas dans les seuils ou les
empreintes, et il faut le régler avant d'empiler d'autres couches par-dessus.
