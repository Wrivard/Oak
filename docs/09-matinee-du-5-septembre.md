# Ce qui a été fait pendant la matinée du 5 septembre

Suite de `docs/08-nuit-du-5-septembre.md`, à lire après lui.

**Départ :** 196 tests, l'application telle que tu l'as vue en te levant.
**Arrivée :** 305 tests, 16 commits, et **huit pannes trouvées en exécutant**.

Aucune n'est venue d'une relecture. Toutes sont venues de faire tourner le
système contre de vraies données, à volume réel.

---

## À lire en premier : deux choses te concernent

### 1. Ta base Supabase est passée en lecture seule pendant vingt minutes

C'est moi. En écrivant 200 000 empreintes synthétiques pour mesurer le niveau 1
à l'échelle, la base est montée de 138 Mo à 850 Mo, et Supabase a coupé les
écritures — le plan gratuit plafonne à **500 Mo de base de données**.

**C'est réparé.** Espace récupéré, base à 138 Mo, écritures rétablies, données
d'exploitation remises à zéro. Tu démarres sur une base propre : 0 scan,
0 inventaire, 0 empreinte, catalogue intact (20 444 cartes, 20 392 embeddings).

Ce que l'incident a révélé compte plus que l'incident, et c'est le point 2.

### 2. Le quota gratuit te donne trois à cinq mois, pas plus

`known_fingerprints` gagne **une ligne par scan résolu**. `cards` et
`card_embeddings` occupent déjà 121 Mo des 500. Il reste ~379 Mo :

```
avant ce matin (index HNSW inutile)   ~68 000 empreintes   ->  6 à 8 semaines
maintenant                           ~131 000 empreintes   ->  3 à 5 mois
```

Au-delà, **la base passe en lecture seule et le pipeline s'arrête net** : plus
un scan, plus une vente enregistrée. Ce n'est pas un ralentissement.

J'ai doublé le délai en retirant un index HNSW que **aucune requête
n'interrogeait** (migration 009) : les deux recherches vectorielles du système
portent sur `card_embeddings`, et le niveau 1 compare des distances de Hamming,
qu'aucun index HNSW ne peut accélérer. Il coûtait 2,7 ko par empreinte *et* une
écriture d'index sur le chemin le plus chaud du système.

Le mur n'est pas supprimé, il est repoussé — et il est maintenant **visible** :
« Taille de la base » sur `/dashboard`, avertissement à 80 %, alarme à 95 %.
Quand tu t'en approcheras, la décision sera de passer au plan Pro.

---

## Les huit pannes

**1. Glisser le dossier du scanner rendait zéro photo.** Un scanner ne produit
pas des fichiers, il produit un dossier. `dataTransfer.files` est vide quand on
glisse un dossier — l'écran affichait « Glisse tes photos ici » sans rien
expliquer. C'était **le premier geste de ta journée**. Deux pièges dedans :
`readEntries` ne rend que 100 entrées à la fois sans le signaler (un lot de 850
pages serait tombé à 100, décalant tout l'appariement recto/verso), et un `.tif`
de scanner arrive souvent avec un type MIME vide.

**2. `Demarrer.bat` lançait un worker qui mourait aussitôt.** Next charge
`.env.local` tout seul ; le worker, non. Le lanceur l'ouvre dans un `cmd` neuf,
sans rien : il s'arrêtait sur « DATABASE_URL: Required » dans une fenêtre
réduite que personne ne regarde, pendant que l'application, elle, démarrait
parfaitement. Tu aurais envoyé un lot entier en attendant qu'il se passe quelque
chose. C'était la panne bloquante de ce matin.

**3. La sauvegarde ne se restaurait pas.** `invalid input syntax for type json`
dès qu'un scan portait des candidats — c'est-à-dire sur toute donnée réelle.
node-pg sérialise un objet JavaScript en JSON mais un **tableau** en littéral de
tableau Postgres. Le test ne l'avait pas vu parce qu'il fabriquait des scans
*sans* candidats : il vérifiait l'aller-retour sur la seule forme qui marchait.

**4. Et la restauration prenait huit minutes par table.** Une ligne par requête,
32 ms d'aller-retour contre le pooler. Par lots : **2,4 s pour 15 000 lignes**.
La sauvegarde chargeait aussi la table entière en mémoire — à 200 000 scans
portant chacun un embedding, plus d'un gigaoctet de tampon avant la première
ligne écrite. Elle pagine maintenant par curseur.

**5. Une page illisible ne laissait aucune trace.** `pair_upload` attrapait
l'échec de décodage, écrivait un `log.error` et passait à la suivante. La feuille
avait pourtant traversé le scanner. Elle laisse maintenant une ligne `rejected`,
visible dans le lot et comptée dans la réconciliation.

**6. « Toutes les sessions balancent » alors que rien n'était vérifié.**
`expected_count` est nul tant qu'on ne le saisit pas : le contrôle était
inactif, et l'écran disait que tout allait bien. C'est une fausse assurance sur
exactement le point qu'on ne peut pas rattraper — une carte scannée sans ligne
d'inventaire ne se retrouve jamais.

**7. Une alarme allumée en permanence.** Le taux de manuel comptait les cartes
encore en review comme du manuel. Sur un lot fraîchement envoyé, l'écran
affichait « 77 % manuel · Alarme » pour un pipeline qui se comportait exactement
comme prévu. À 1 700 cartes par jour, la review est toujours en retard sur
l'ingestion : l'alarme serait allumée tous les jours, et on apprend à ne plus la
regarder — y compris le jour où elle a raison.

**8. L'export TCGplayer produisait un fichier vide en silence.** Il écarte la
totalité de l'inventaire faute de `tcg_sku_id`, le note dans `channel_events`, et
rien à l'écran ne le disait. On pouvait téléverser un fichier sans lignes des
jours durant en croyant pousser son stock.

---

## Ce qui a changé à l'écran

| | |
|---|---|
| **Envoyer** | glisser un **dossier**, deux boutons explicites, « Cartes comptées », avertissement si le lot contient déjà des pages, et le nombre exact de pages arrivées quand un envoi casse |
| **Review** | trois colonnes — le scan, **la décision**, les réglages. Les vignettes des candidats voisins sont préchargées |
| **Prix** | l'éditeur JSON est devenu de **vrais champs** : plancher, bandes, condition, canal, garde-fous. Le JSON reste en bas, replié |
| **Santé** | trois métriques de plus (export TCGplayer, taille de la base), et deux qui ne mentent plus |

---

## Ce qui a été mesuré

```
15 000 SKUs + 15 000 scans, les neuf pages          6 à 303 ms
  tri par nom, page 300, recherche plein texte      < 200 ms
niveau 1 sur 120 000 empreintes, cache chaud        45 à 62 ms
sauvegarde de 30 000 lignes                         1,6 s
restauration de 15 000 lignes                       2,4 s   (8 min avant)
répétition complète, 40 cartes                      réconciliation exacte
dix formats de scanner (TIFF, CMJN, gris, 600 dpi)  8 acceptés, 2 écartés
```

**L'architecture tient.** Rien dans les écrans ne s'effondre au volume cible, et
le niveau 1 reste à quelques dizaines de millisecondes parce que la colonne
`embedding` part en TOAST et que le balayage ne la lit jamais.

Deux optimisations essayées et **rejetées** faute de preuve : un index couvrant
sur `known_fingerprints` (mesuré plus lent que le balayage séquentiel) et un
`lateral` pour ne calculer les `bit_count` qu'une fois (spectaculaire à froid,
identique à chaud — c'était la différence entre cache froid et chaud, pas entre
les deux écritures).

---

## Trois commandes nouvelles

```
pnpm verify        typecheck + tests + build + smoke, en une fois
pnpm repetition    le parcours de ta journée par les VRAIS chemins HTTP
pnpm edge          dix formats de scanner, dont deux fichiers corrompus
pnpm seed:volume   remplit la base au volume cible (--purge pour effacer)
```

`pnpm smoke` charge réellement les neuf pages et vérifie que la coquille rend.
Il existe parce que `/pricing` a renvoyé 500 pendant deux étapes avec un build
vert : un build qui compile n'est pas une page qui charge.

⚠️ `pnpm seed:volume` écrit 15 000 lignes. Pense à `--purge` — c'est en oubliant
l'équivalent que j'ai rempli la base ce matin.

---

## Ce qui n'a pas changé, et reste vrai

- **Aucun prix eBay réel** — `fetchEbayComps()` rend une liste vide tant que la
  source de ventes passées n'est pas choisie (expérience 1).
- **Le net est une estimation** — taux de frais non vérifiés, étiquetés comme tels.
- **L'export TCGplayer écarte tout** — `tcg_sku_id` est vide. Maintenant visible
  sur `/dashboard` au lieu d'être silencieux.
- **La porte de non-régression du matching est inactive** — le golden set est
  vide. `pnpm golden:export` le constitue à partir de tes reviews.

---

## Par où commencer

`docs/07-premier-test.md`, inchangé : six tests dans l'ordre. Le test 2 reste
celui qui décide de la suite — le taux de lecture OCR sur `/diagnostics`.

Double-clique `Demarrer.bat`. Il fonctionne maintenant, ce qui n'était pas le
cas hier soir.
