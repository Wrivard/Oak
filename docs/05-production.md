# 05 — Production

Ce doc est ce qui sépare un prototype d'un système que tu laisses tourner la nuit.

---

## 1. Observabilité

À 1 700 cartes/jour, tu ne peux pas debugger en lisant des logs. Il te faut trois choses.

### 1.1 Logs structurés

JSON uniquement, jamais de `console.log` de string. Chaque ligne porte un contexte
corrélable.

```ts
log.info({
  evt: 'scan.resolved',
  scan_id, session_id, sku,
  match_source, confidence,
  duration_ms,
}, 'scan resolved');
```

Champs obligatoires sur toute ligne touchant une carte : `scan_id`, `session_id`, et
`sku` dès qu'il est connu. Sans ça tu ne peux pas reconstituer le parcours d'une carte.

### 1.2 Le dashboard qui compte

Une seule page, cinq métriques. Si elle est verte, tu peux aller dormir.

| Métrique | Seuil d'alarme |
|---|---|
| Taux de résolution par niveau (own_history / catalog / manual) | `manual > 15 %` **des scans décidés** |

> **Mesuré le 5 septembre 2026 :** le calcul comptait les scans encore en review
> comme du manuel. L'écran affichait « 77 % manuel · Alarme » sur un lot dont
> onze cartes venaient d'être résolues par le catalogue et trente-sept
> attendaient la review. À 1 700 cartes par jour, cette alarme serait allumée en
> permanence — et une alarme toujours allumée n'est plus une alarme. Le taux se
> calcule maintenant sur les scans **décidés** ; l'arriéré garde sa propre
> métrique, « Cartes en review », avec son seuil sur la capacité quotidienne.
> Le calcul vit dans `lib/metrics/mix.ts`, séparé du SQL, parce que c'est lui
> qui était faux.
| Profondeur de queue par type de job | `> 5 000` ou croissance monotone 1 h |
| Jobs `dead` dernières 24 h | `> 0` |

> **Un job mort ne doit pas emporter le lot.** Le job, lui, est visible : cette
> métrique alarme dès le premier. Mais le **scan** restait dans son état de
> traitement pour toujours, et la clôture d'un lot refuse tant qu'une carte est
> en traitement — un seul job mort rendait donc la réconciliation d'un lot entier
> impossible. `reapStrandedScans()` tourne avec le cron horaire et récupère les
> scans abandonnés : **écarté** si l'empreinte a échoué (sans empreinte la review
> ne peut rien en faire, `confirmScan` la refuse — la carte est à repasser au
> scanner), **en review** si c'est le matching qui a échoué, puisque le scan
> porte alors son image et ses empreintes et que c'est exactement ce que le
> niveau 3 est censé recevoir.
| Écart de réconciliation eBay | `> 0` |

> **Mesuré le 5 septembre 2026 :** cette métrique affichait « toutes les sessions
> balancent » alors qu'aucun lot ouvert n'avait de comptage attendu — c'est-à-dire
> pendant que le contrôle était purement inactif. `expected_count` reste nul tant
> qu'on ne saisit pas à la main le nombre de cartes mises dans le scanner, donc le
> cas « non vérifiable » est le cas **normal**, pas un cas limite. L'absence
> d'écart et l'absence de contrôle ne sont pas la même chose, et confondre les
> deux donne une fausse assurance sur exactement le point qu'on ne peut pas
> rattraper plus tard. Voir `lib/metrics/reconciliation.ts`.
| Cartes en `needs_review` | `> capacité quotidienne` |
| Dernier export TCGplayer | fichier vide alors qu'il restait du stock à exporter |
| Taille de la base contre le quota du plan | `> 80 %` — **lecture seule au quota** |

> **Incident du 5 septembre 2026.** En écrivant 200 000 empreintes synthétiques
> pour mesurer le niveau 1, la base est passée de 138 Mo à 850 Mo et Supabase a
> mis le projet en **lecture seule**. Plus aucune écriture : ni scan, ni
> inventaire, ni vente. Le `reset:data` de nettoyage a lui-même échoué sur
> `cannot execute DELETE in a read-only transaction`.
>
> Sortie de secours documentée par Supabase, et elle marche — mais il faut les
> deux commandes **dans la même session**, ce qui n'est pas évident :
>
> ```sql
> set session characteristics as transaction read write;
> delete from …;  vacuum full …;
> ```
>
> Ce que l'incident a révélé compte plus que l'incident. Le quota gratuit est de
> **500 Mo de base de données**, dont `cards` et `card_embeddings` occupent déjà
> 121. Il reste ~379 Mo, et `known_fingerprints` gagne **une ligne par scan
> résolu**. Mesuré sur 20 000 empreintes :
>
> ```
> tas                 2,4 Mo
> embeddings (TOAST) 52,6 Mo
> index HNSW         52,0 Mo   ← inutilisé, retiré par la migration 009
> btree phash + card  1,3 Mo
> total             109 Mo,  soit 5,6 ko par empreinte
> ```
>
> Aucune requête n'interrogeait cet index HNSW : les deux recherches
> vectorielles du système portent sur `card_embeddings`, et le niveau 1 compare
> des distances de Hamming, qu'aucun index HNSW ne peut accélérer. Il coûtait
> 2,7 ko par empreinte **et** une écriture d'index sur le chemin le plus chaud
> du système.
>
> ```
> avec l'index HNSW    ~68 000 empreintes   ->  6 à 8 semaines
> sans                ~131 000 empreintes   ->  3 à 5 mois
> ```
>
> Le mur n'est pas supprimé, il est repoussé — et il est maintenant **visible** :
> le tableau de santé avertit à 80 % et alarme à 95 %, en disant ce qu'on perd
> au passage du quota. Un seuil dont on ignore la conséquence finit par être
> ignoré.

> **Ajouté le 5 septembre 2026.** L'export tourne par cron et écrit un CSV.
> Quand il écarte tout — aujourd'hui parce que `tcg_sku_id` est vide sur tout
> l'inventaire — il produit un fichier **vide**, note le détail dans
> `channel_events`, et rien à l'écran ne le disait. On pouvait donc téléverser
> un fichier sans lignes des jours durant en croyant pousser son stock. L'écart
> n'est pas une erreur en soi : une carte sans `tcg_sku_id` ne peut pas être
> exportée, et l'inventer serait pire. Ce qui manquait, c'était de le voir.

Le **taux de review manuelle** est ta métrique économique principale : c'est le seul
poste de coût marginal par carte qui reste, et il se paie en minutes de ton temps.
S'il remonte, quelque chose a changé : nouveaux sets non seedés, réglages scanner
modifiés, OCR qui décroche sur une ère, seuils dérivés. Il devrait descendre avec le
temps, jamais monter.

### 1.2bis La sixième métrique : le worker draine-t-il ?

Elle n'est pas dans la liste ci-dessus, et c'est pourtant la panne la plus probable
en exploitation réelle : **on ferme la fenêtre du worker sans y penser**. On envoie
ensuite un lot, rien ne se passe, et aucun écran ne dit pourquoi.

Détection : des jobs prêts depuis plus de deux minutes **et** aucun job terminé
pendant ce temps. Personne ne draine.

Le signal ne vit pas seulement sur le dashboard — une bannière rouge s'affiche sur
**toutes** les pages, avec la commande exacte à lancer. Si le worker ne tourne pas,
rien de ce qu'on fait ailleurs n'aura d'effet, et il n'y a aucun autre indice.

Le worker est affiché en PREMIER sur le dashboard : quand il est arrêté, les cinq
autres métriques décrivent un système figé et n'apprennent rien.

### 1.3 Traces sur les appels externes

Chaque appel eBay et tcgapi : durée, statut, taille de payload, et pour eBay
les headers de rate limit. Stocke-les dans `channel_events`. Quand eBay renvoie une
erreur cryptique dans six mois, tu veux le payload exact qui l'a causée.

---

## 2. Gestion d'erreurs

### 2.1 Classification

Trois catégories, trois comportements. Toute erreur doit tomber dans une seule.

| Catégorie | Exemples | Comportement |
|---|---|---|
| **Transitoire** | 429, 503, timeout réseau | retry avec backoff exponentiel |
| **Permanente** | 400 validation, aspect manquant, SKU inexistant | `dead` immédiat, pas de retry |
| **Ambiguë** | 500 d'eBay, réponse malformée | 2 retries max puis `dead` |

Retryer une erreur permanente 5 fois, c'est brûler du quota et retarder les vrais jobs.
Écris un `classifyError(err)` et teste-le.

### 2.2 La règle d'or de l'idempotence

Tout job qui produit un effet de bord externe (publier une annonce, uploader une image,
décrémenter un stock) doit porter une `idempotency_key` déterministe.

```ts
// ✅ déterministe: rejouable sans danger
idempotency_key = `ebay_publish:${sku}:${offerVersion}`
idempotency_key = `ebay_sale:${orderId}:${lineItemId}`

// ❌ un retry crée un doublon
idempotency_key = `ebay_publish:${Date.now()}`
```

Avant tout effet de bord, vérifie si la clé existe déjà en `done`. Si oui, sors sans rien
faire et retourne le résultat mémorisé.

### 2.3 Ce qu'on ne fait jamais

- `catch {}` vide
- Retry sur un upload TCGplayer (le delta s'appliquerait deux fois)
- Résolution automatique d'oversell
- Repricing automatique quand `method === 'no_data'`
- Continuer un batch après 20 échecs consécutifs — c'est un problème systémique, arrête
  le worker et alerte

### 2.4 Circuit breaker

Par service externe. Après 10 échecs consécutifs, ouvre le circuit pour 5 minutes et
repousse les jobs concernés. Sans ça, une panne eBay de 20 minutes te fait brûler
`max_attempts` sur des milliers de jobs et tu te retrouves avec une montagne de `dead`
à rejouer à la main.

---

## 3. Tests

### 3.1 Priorités

Ce qui doit avoir des tests unitaires avant d'aller en prod, dans l'ordre :

1. **`suggestPrice`** — tous les cas du tableau de bandes, plus : valeur `null`,
   valeur négative, condition inconnue, valeur exactement sur une frontière de bande
2. **`estimateValue`** — 0/1/2/3/10 comps, comps avec aberrations, toutes sources `null`
3. **`allocate`** — qty 0, 1, 2, 3, 10, 100
4. **Delta TCGplayer** — la séquence push → vente → push, en vérifiant que le second
   delta est correct et pas cumulatif
5. **Génération de titre** — 500 cartes réelles, aucun > 80 caractères
6. **`classifyError`**

### 3.2 Golden set du matching

Constitue un jeu de 500 scans réels étiquetés à la main. C'est ton harnais de
non-régression pour tout changement de seuil ou de modèle.

```
tests/fixtures/golden/
  ├── scans/          500 images
  └── labels.json     { scan_id: { sku, variant, condition } }
```

Le test échoue si la précision descend sous la ligne de base ou si le taux de review
manuelle monte de plus de 2 points. **Aucun changement de seuil ne se merge sans passer ce
test.** C'est la seule protection contre l'optimisation d'un seuil qui améliore un cas
et en casse cinquante.

### 3.3 Environnements externes

- eBay a un **sandbox**. Utilise-le pour tout le développement du flux de publication.
- Le sandbox ne reproduit pas fidèlement les aspects par catégorie. Prévois une phase
  de validation en production sur 10 cartes réelles avant d'ouvrir les vannes.

### 3.4 Test de charge minimal

Avant la première vraie journée : passe 2 000 scans synthétiques dans le pipeline et
mesure le débit bout en bout, la profondeur de queue, la mémoire du worker sur une heure.
Un leak dans le traitement d'image ne se voit pas sur 50 cartes.

---

### 3.4bis Résultats mesurés — 2 000 scans, 2026-09-05

```
scans                 2000        images distinctes     199
durée                 32,4 min    débit                 61,7 cartes/min
file max              1871        RSS max               205 Mo
jobs morts            0           ingestion             2000/2000, 0 perte
```

**Débit.** 61,7 cartes/minute, soit 3 700/heure. Les 1 700 cartes quotidiennes se
traitent en **28 minutes de worker**. Le goulot est l'OCR du niveau 2 : les 2 000
empreintes étaient calculées en quelques minutes, le reste du temps est du matching.

**Mémoire.** 205 Mo au pic, stable. Pas de fuite sur 32 minutes de charge continue.

**Le p95 des jobs (26 min) est de la latence de FILE, pas du traitement.** Les 2 000
fichiers sont déposés d'un coup ; un job enfilé à la première seconde attend que 1 999
autres passent. Sur un flux réel d'ADF ce chiffre n'a pas de sens — c'est le débit qui
compte.

### La découverte qui compte : la duplication n'améliore rien toute seule

| | total | résolues | auto |
|---|---|---|---|
| première occurrence | 199 | 81 | **40,7 %** |
| répétitions | 1 801 | 734 | **40,8 %** |

Les deux taux sont **identiques**, et ce n'est pas un hasard : une carte n'entre dans
`known_fingerprints` que si elle est **résolue**. Les 59 % qui partent en review
n'écrivent aucune empreinte, donc leurs répétitions repartent en review elles aussi. Les
81 qui se résolvent au premier passage font résoudre leurs ~9 répétitions par le niveau 1
— 734, exactement ce qu'on observe.

**Conséquence économique, et elle est structurante :**

> Le taux d'auto-résolution global est entièrement déterminé par le taux de réussite à la
> **première occurrence**. La duplication n'améliore rien — elle **amplifie** ce taux,
> quel qu'il soit.

Le corollaire est plutôt une bonne nouvelle : **l'effort de review est proportionnel au
nombre de cartes DISTINCTES, pas au volume total.** À 12-15k SKUs uniques pour
25-50k cartes/mois, reviewer une carte est un coût unique, amorti sur toutes ses
répétitions futures. Mais ça veut dire que tout ce qui améliore la première occurrence —
l'OCR (expérience 1bis), les seuils, la fraîcheur du catalogue — se multiplie par le
taux de duplication.

> ⚠ Les 40,7 % de première occurrence portent sur des **renders officiels**, pas des
> scans ADF. Ce n'est pas le chiffre de production, c'est la démonstration du mécanisme.
> Le vrai taux dépend de l'OCR sur de vraies numérisations — expérience 1bis.

### 3.4ter Deux plafonds trouvés à 800 cartes

**Le pooler Supabase est limité à 15 clients en mode session.** Deux process à
10 connexions chacun font 20, et le vingt-et-unième reçoit
`EMAXCONNSESSION: max clients reached`. Sous charge, l'application et le worker
s'affament mutuellement — et `psql` ne peut même plus se connecter pour
diagnostiquer.

Symptôme observé : `/batches` à **2,2 secondes** avec seulement 4 lots. La requête
n'y était pour rien (0,4 ms mesurée) : c'était l'attente d'une connexion. Après
bornage à 5 connexions par process, la même page répond en **64 ms**, et `psql`
fonctionne à côté.

`PG_POOL_MAX` règle la taille par process. L'augmenter sans augmenter la limite du
pooler ne rend rien plus rapide : ça déplace l'attente du pool applicatif vers un
refus du serveur.

**Les voies inactives reculent.** Le worker ouvre une voie par slot de concurrence :
quatre `fingerprint`, deux `match`, une pour chacun des trois autres types, soit neuf.
À 500 ms fixes, ça faisait **18 réclamations par seconde en permanence, pour rien** —
et ces requêtes à vide se disputaient les cinq connexions du pool avec le travail réel.

Le délai croît de ×1,6 à chaque réclamation vide et repart au minimum dès qu'un job est
trouvé : un lot arrive rarement seul, la carte suivante ne doit pas attendre. Mesuré :
500, 800, 1280, puis plafond — **2,6 s d'inactivité** avant qu'une voie ne passe au
sondage plafonné.

Le plafond est par type, dans `worker/index.ts` : deux secondes sur ce qu'un humain
attend (`fingerprint`, `match`, `pair_upload`), dix secondes sur le travail de fond
(`price_refresh`, `tcg_export`). Le sondage à vide tombe de ~18 à ~3,7 requêtes par
seconde, pour au pire deux secondes de latence sur un chemin où l'écran se rafraîchit
déjà toutes les cinq.

La boucle elle-même est couverte par `tests/worker-loop.test.ts` : enfiler un job, le
laisser finir, laisser la voie atteindre son plafond, en enfiler un second et vérifier
qu'il part aussi. Une voie qui s'endort et ne se réveille plus arrêterait le pipeline
sans une seule erreur dans les journaux.

**La mémoire du worker ne fuit pas.** Sur 800 cartes en quatre lots successifs dans
le même process : 725 → 806 → 525 → 518 Mo. Elle oscille entre 500 et 800 Mo et
redescend — c'est le ramasse-miettes, pas une fuite. Le poids vient du modèle CLIP
et des arènes d'onnxruntime, pas de sharp : mesuré, la concurrence de sharp ne
change ni la vitesse (2,1 s pour 120 images) ni la mémoire (~145 Mo), de 1 à
24 threads.

### 3.5 Ce que le test de charge a réellement trouvé

Le test de charge n'est pas une formalité : la **première** exécution a révélé un bug
qui aurait perdu des scans en production. Voir `docs/02` §1 pour le détail — ingestion
non bornée, pool de connexions épuisé, 1 849 fichiers abandonnés en silence.

Retiens-en la méthode : ce bug était invisible en test unitaire et invisible sur trois
cartes. Il n'apparaît qu'en rafale. **Refais tourner `pnpm loadtest` après toute
modification du watcher, de la boucle worker ou du pool.**

---

## 4. Sécurité et secrets

- Aucun secret dans le repo. `.env.local` en dev, variables d'environnement en prod.
- Les tokens eBay (access + refresh) chiffrés au repos en base, jamais loggés, jamais
  dans un message d'erreur. Écris un redacteur de logs qui masque tout ce qui ressemble
  à un token.
- La `service_role` key Supabase ne touche jamais le navigateur. Les route handlers
  et les server actions Next l'utilisent côté serveur, au même titre que le worker.
  Acceptable en mono-utilisateur. **Ne pas ajouter de RLS** — c'est un non-objectif
  explicite (voir `CLAUDE.md`).
- Rotation planifiée du refresh token eBay avec alerte à J-30 avant expiration.
- `.gitignore` : `.env*`, `inbox/`, `processed/`, `*.csv`, `tests/fixtures/golden/scans/`
  (des milliers d'images n'ont rien à faire dans git — utilise git-lfs ou un bucket).

---

## 5. Sauvegardes et reprise

Ce qui est irremplaçable, par ordre de douleur si tu le perds :

1. **`known_fingerprints`** — c'est des mois de review manuelle. Backup quotidien,
   testé en restauration au moins une fois.
2. **`inventory`** — ton stock réel. Si tu le perds, tu rescannes tout physiquement.
3. `price_history`, `channel_events` — utile, pas vital.

Ce qui est reconstructible et ne mérite pas de backup : `cards`, `card_embeddings`
(reseedables), les images (chez eBay), `price_current` (refetchable).

**Teste ta restauration.** Un backup jamais restauré n'est pas un backup.

> **Mesuré le 5 septembre 2026, à 15 000 SKUs et 15 000 scans.** La restauration
> insérait UNE LIGNE PAR REQUÊTE : contre le pooler Supabase, un aller-retour
> coûte 32 ms, soit 64 s pour 2 000 lignes et huit minutes pour 15 000 — par
> table. Le test d'aller-retour dépassait son budget de 120 s. Un backup qu'on
> ne peut pas restaurer dans un temps utile n'est qu'à moitié un backup.
>
> Insertion par lots, bornée par la limite de 65 535 paramètres liés de
> Postgres : **2,4 s pour 15 000 lignes d'inventaire, 2,2 s pour 15 000 scans**.
> Les lignes sont regroupées par signature de colonnes — un fichier édité à la
> main ou une sauvegarde d'un schéma antérieur peut mélanger des lignes de clés
> différentes, et les insérer ensemble décalerait les valeurs d'une colonne, ce
> qui est pire qu'un échec.
>
> La sauvegarde, elle, lisait la table entière en mémoire. À 200 000 scans
> portant chacun un embedding sérialisé (512 flottants, ~8 Ko), c'est plus d'un
> gigaoctet de tampon avant la première ligne écrite : elle tomberait le jour où
> elle devient indispensable. Elle pagine maintenant par curseur sur la clé
> primaire — pas par `offset`, qui ferait relire 200 000 lignes à chaque tranche
> — et respecte la contre-pression du flux d'écriture. 30 000 lignes en 1,6 s.

> **Mesuré le 5 septembre 2026 :** la restauration échouait sur `invalid input
> syntax for type json` dès qu'un scan portait des candidats — c'est-à-dire sur
> toute donnée réelle. node-pg sérialise un objet JavaScript en JSON, mais un
> **tableau** en littéral de tableau Postgres. Le test de restauration ne
> l'avait pas vu parce qu'il fabriquait des scans sans candidats : il vérifiait
> l'aller-retour sur la seule forme qui marchait. Les colonnes `jsonb` sont
> maintenant listées explicitement dans `scripts/backup.ts` et ré-sérialisées à
> la main, et le test porte un tableau *et* un objet.

---

## 6. Runbooks

### 6.1 « La queue monte et ne redescend pas »

1. `select type, status, count(*) from jobs group by 1,2` — identifier le type bloqué
2. `select last_error, count(*) from jobs where status='failed' group by 1 order by 2 desc`
3. Si une seule erreur domine : c'est systémique, arrête le worker avant de brûler du quota
4. Si l'erreur est un 429 : vérifie le circuit breaker, il devrait déjà être ouvert

### 6.2 « Une session ne se ferme pas (écart de comptage) »

Écart entre `expected_count` et `scanned_count` = double-feed probable.

1. Ne ferme pas la session
2. Repasse physiquement la pile
3. Compare les `seq` présents dans `scans` pour trouver les trous
4. Si l'écart persiste, la pile est physiquement recomptée avant tout listing

Ne contourne jamais cette vérification. Une carte fantôme dans l'inventaire finit en
commande non honorable.

### 6.3 « Des prix aberrants sont partis en prod »

1. `select * from price_history where created_at > $t and reason='reprice'`
2. Identifier la source fautive via `breakdown`
3. Rollback : republier depuis `price_history` la valeur précédente pour les SKUs touchés
4. Ajouter un cas au test unitaire de `estimateValue` pour le pattern rencontré

C'est pour ça que `price_history` garde le `breakdown` complet. Sans lui, ce runbook est
impossible à exécuter.

### 6.4 « Le taux de review manuelle a doublé »

Causes par ordre de probabilité : un nouveau set est sorti et n'est pas dans `cards` ;
les réglages du scanner ont changé ; l'OCR du numéro échoue sur une ère donnée ;
les seuils ont été touchés sans passer le golden set.

1. `select date_trunc('day',created_at), match_source, count(*) from scans group by 1,2`
2. Vérifier la date du dernier seed catalogue
3. Comparer `sessions.scanner_profile` entre une session saine et une session dégradée

---

## 7. Ce que ce système ne fera jamais

Écris-le dans le repo pour que ni toi ni un agent ne dérive :

- Il ne devine jamais un prix quand il n'a pas de données
- Il n'annule jamais une commande automatiquement
- Il ne republie jamais une annonce sans clé d'idempotence
- Il n'écrase jamais une ligne d'inventaire eBay sans GET préalable
- Il ne retry jamais un upload TCGplayer
- Il ne ferme jamais une session dont le comptage ne balance pas

---

## 7ter. Les invariants sont testés, pas seulement écrits

`CLAUDE.md` énonce des règles dont la violation **ne casse aucun test**. Elle
change en silence ce que le système fait ou ce qu'il coûte : un appel à l'API
Claude depuis le code d'une application payée par abonnement ne casse rien, il
facture ; un appel externe dans une requête HTTP ne casse rien, il fait expirer
la requête le jour où le réseau est lent.

`tests/invariants.test.ts` lit les sources et vérifie sept d'entre elles :

- aucun SDK Anthropic, aucune lecture d'`ANTHROPIC_API_KEY` ;
- aucun `fetch` vers un hôte externe dans le code **serveur** de `app/` ;
- `delete from inventory` nulle part hors des scripts d'effacement volontaire ;
- aucune concaténation de SKU hors de `lib/sku.ts` ;
- aucun `catch` **totalement** vide — un `catch` commenté qui prend une décision
  explicite reste la pratique du projet et reste permis ;
- ni `any` ni assertion non-null dans le code applicatif ;
- aucun `parseFloat` dans le code qui touche à l'argent.

Le fichier commence par vérifier qu'il a bien collecté des sources : sans ce
garde-fou, une erreur de chemin ferait passer les sept règles en ne lisant rien.

## 7bis. Le pipeline est testé de bout en bout

Chaque étage avait ses tests ; leur **enchaînement** n'en avait pas. Il vivait
dans `pnpm repetition`, un script qu'on lance à la main avec un serveur et un
worker à côté — donc une régression dans le passage de relais entre deux étages
ne se serait vue qu'en le lançant.

`tests/pipeline.test.ts` fait tourner l'appariement, les empreintes et le
matching sur de **vraies images de cartes**, à la suite, en quelques secondes :

- quatre pages recto/verso donnent **deux** cartes, pas quatre ;
- le verso est rattaché et son empreinte enregistrée — c'est ce qui attrape une
  carte insérée à l'envers ;
- rejouer l'appariement ne crée pas de doublon ;
- le chemin écrit en base reste lisible par l'étage suivant (le piège d'ordre
  qui avait tué 100 % des jobs une fois) ;
- chaque scan finit sur une issue **terminale** — résolu avec son SKU, sa
  quantité et son empreinte, ou en review avec des candidats. Jamais en suspens,
  jamais avec une page blanche à trier.

## 8. Le lanceur

`Demarrer.bat` reconstruit, démarre le worker puis l'application, attend que
l'application réponde, ouvre le navigateur et affiche les adresses réseau.

**Mesuré le 5 septembre 2026 :** il démarrait un worker qui mourait
immédiatement. Next charge `.env.local` tout seul ; le worker, non — il lisait
uniquement l'environnement du process, et le lanceur l'ouvre dans un `cmd` neuf.
Le worker s'arrêtait donc sur « DATABASE_URL: Required » dans une fenêtre
réduite que personne ne regarde, pendant que l'application, elle, tournait
parfaitement. On pouvait envoyer un lot entier et attendre indéfiniment.

Deux corrections, indépendantes l'une de l'autre :

- `lib/dotenv.ts` charge `.env.local` puis `.env` dans `loadEnv()`. Les valeurs
  déjà présentes dans l'environnement **gagnent toujours** : `PG_POOL_MAX=2 pnpm
  worker` continue de faire ce qu'il annonce, et en production les vraies
  variables priment sur un fichier oublié sur le disque. La fonction ne renvoie
  que des noms de clés, jamais des valeurs — un fichier d'environnement contient
  un mot de passe de base.
- **il refuse de démarrer deux fois.** Double-cliquer le fichier une seconde fois
  est un geste normal quand on n'est pas sûr que ça a marché. Un second worker
  n'échouerait pas bruyamment : il tournerait à côté du premier. Or
  `pair_upload` alloue ses numéros d'ordre par `max(seq) + 1`, ce qui n'est sûr
  qu'à un seul processus — à deux, une page se fait écraser en silence. Deux
  processus doublent aussi les connexions, et le pooler Supabase plafonne à 15.
  Le contrôle est fait **avant** la reconstruction : inutile d'attendre sept
  secondes pour finir par refuser.
- **le journal précédent est conservé** en `logs/worker.precedent.log`. La
  redirection `>` écrase, et c'est exactement le fichier qu'on veut lire : quand
  le worker meurt, le réflexe est de relancer, et relancer effaçait la seule
  explication.
- le lanceur écrit le journal du worker dans `logs/worker.log`, vérifie après
  démarrage que le process est encore là, et affiche les dernières lignes du
  journal s'il ne l'est pas. C'est la panne qui ne se voit pas : l'application
  démarre parfaitement sans worker.

---

## 9. Ce qui grossit sans qu'on le regarde

Trois choses grossissent en exploitation normale. Deux sont bornées, la
troisième ne l'était pas.

| Quoi | Croissance | Borne |
|---|---|---|
| `channel_events` (traces d'API) | une ligne par appel externe | `pruneTraces()`, 30 jours |
| `.thumb-cache` | une vignette de ~60 ko **par scan** | `pruneThumbs()`, 30 jours |
| `jobs` | 258 octets × **2 jobs par carte** | `pruneJobs()`, 14 jours, `done` seulement |
| `known_fingerprints` | une ligne de ~2,9 ko **par scan résolu** | aucune — voir §1, le mur des 500 Mo |

**Mesuré le 5 septembre 2026 :** rien n'effaçait les vignettes. À 25-50 000
cartes par mois, ça fait 1,5 à 3 Go par mois sur le disque local,
indéfiniment — des dizaines de gigaoctets de vignettes de cartes vendues depuis
longtemps. Une vignette ne sert qu'à la review et à l'audit ; passé quelques
jours elle se régénère à la demande en quelques dizaines de millisecondes. La
purge ne perd rien, elle diffère un recalcul rare.

**Mesuré aussi le 5 septembre 2026 :** un job pèse **258 octets**, index
compris. À 1 700 cartes par jour et deux jobs par carte, ça fait 878 ko par jour
et **320 Mo par an** — sur un quota de 500 Mo dont le catalogue occupe déjà 121.
La file aurait fini par coûter plus cher que les empreintes qu'elle sert à
produire, pour de l'historique que personne ne relit. Seuls les `done` sont
purgés : les `dead` restent, ce sont eux la trace de ce qui a échoué et le
tableau de santé les compte. Effacer une clé d'idempotence vieille de quatorze
jours n'est pas un risque — un `fingerprint` ou un `match` rejoué trouve un scan
déjà traité et sort en silence, un `pair_upload` rejoué ignore les fichiers déjà
rattachés.

`known_fingerprints` reste la seule croissance non bornée, et c'est délibéré :
chaque empreinte est ce qui rend la prochaine occurrence gratuite. C'est aussi
pour ça que le tableau de santé surveille la taille de la base.

