# Ce qui a été fait pendant la matinée du 5 septembre

Suite de `docs/08-nuit-du-5-septembre.md`, à lire après lui.

**Départ :** 196 tests, l'application telle que tu l'as vue en te levant.
**Arrivée :** 381 tests, 48 commits, et **vingt-six pannes trouvées en exécutant**.

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

## Les vingt-six pannes

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

**9. Un printing absent était remplacé par un autre.** `extractPrices` retombait
sur le premier printing disponible quand celui demandé manquait dans la réponse
de pokemontcg.io. Un SKU `reverseHolofoil` dont l'API n'a que `normal` était donc
prixé au prix du normal, publié, vendu — alors que tout le reste du système
refuse de deviner le variant. Mesuré sur une vraie carte, `base6-57`, les deux
printings prixés côte à côte par le pipeline :

```
normal            marché 2,31 $   ->  publié 2,49 $
reverseHolofoil   marché 77,80 $  ->  publié 162,00 $
```

**65x.** Un printing absent ne donne plus aucun prix : la carte part en review
avec la liste des printings que l'API avait réellement.

**10. Un SKU signalé restait dans le batch horaire pour toujours.** Tout SKU
traité est repoussé de 24 h par `last_priced_at` — sauf ceux signalés pour
mouvement de prix anormal, que `flagSwing` oubliait d'estampiller. Ils étaient
re-sélectionnés toutes les heures, re-cherchés auprès de l'API, re-signalés, un
événement par heure et une place du batch de 500 occupée en permanence.

**11. Le taux de lecture OCR baissait quand le système marchait mieux.**
`/diagnostics` divisait par TOUS les scans. Or un scan résolu au niveau 1
n'exécute jamais l'OCR. Le taux aurait donc chuté à mesure que la base
d'empreintes grandit — on aurait lu « le niveau 2 s'effondre » exactement quand
le niveau 1 fait son travail. **C'est le chiffre du test 2, celui qui décide de
la suite du plan de build.** Sur un jeu de contrôle de quatre scans : 25 % avant,
50 % après, avec le détail de ce qui est hors dénominateur.

**12. Un fichier corrompu bloquait la clôture de tout un lot.** L'échec de
décodage tuait le job — visible — mais laissait le scan en `pending` pour
toujours, et la clôture refuse tant qu'une carte est en traitement. Un seul
fichier corrompu rendait la réconciliation d'un lot entier impossible, sur le
contrôle qui est le seul à rattraper une carte perdue.

**13. Et un job mort faisait la même chose.** Même conséquence, cause plus large.
`reapStrandedScans()` tourne avec le cron : le scan est **écarté** si l'empreinte
a échoué (sans empreinte, la review ne peut rien en faire), **envoyé en review**
si c'est le matching — il porte alors son image et ses empreintes, c'est
exactement ce que le niveau 3 attend.

**14. La review ne se remplissait plus une fois vide.** Le réapprovisionnement
était déclenché par un changement de la file. File vide, la file ne change plus,
donc il ne repartait jamais : on restait sur « Rien à reviewer » pendant que le
worker traitait le lot juste derrière. C'est le cas normal — on va sur la review
avant que le worker ait fini.

**15. « Voir en pleine résolution » cassait sur les scans TIFF.** La vignette
était ré-encodée en JPEG, l'image pleine résolution servait les octets bruts sous
un en-tête `image/jpeg`. Aucun navigateur n'affiche le TIFF, qui est le format
par défaut de beaucoup de pilotes de scanner.

**16. Les vignettes ne s'effaçaient jamais.** Une par scan, ~60 ko : 1,5 à 3 Go
par mois sur le disque local, indéfiniment. Purgées à 30 jours, elles se
régénèrent à la demande. Au passage, la liste des extensions d'image était écrite
à trois endroits qui divergeaient déjà — une seule source maintenant, parce
qu'une divergence là crée un fichier accepté que l'appariement ignore.

**17. Deux envois simultanés perdaient les deux tiers des pages.** Le pire de la
liste. Six paquets envoyés en parallèle vers le même nom de lot :

```
avant   48 pages acceptées, 16 fichiers sur le disque, 5 lignes de session
après   48 pages acceptées, 48 fichiers sur le disque, 1 ligne de session
```

Deux défauts se cumulaient. `openSession` faisait « select puis insert » : deux
requêtes concurrentes ne trouvent rien, insèrent toutes les deux, et le lot
existe en double — les scans se répartissent alors entre plusieurs sessions du
même nom, et la réconciliation compare le comptage attendu à une fraction des
cartes. Et le rang des fichiers venait d'une lecture du répertoire, donc deux
requêtes écrivaient les mêmes noms. Le client envoie ses paquets en série, donc
un seul onglet ne peut pas déclencher ça — **deux onglets suffisent**, et c'est
un geste normal quand on a deux piles à traiter. `pnpm course` rejoue la course.

**18. Le lanceur pouvait démarrer un second worker.** Double-cliquer une seconde
fois est un geste normal quand on n'est pas sûr. L'application aurait échoué sur
le port, bruyamment — le worker serait parti en silence. Or l'appariement alloue
ses numéros d'ordre par `max(seq) + 1`, ce qui n'est sûr qu'à un seul processus.
Le lanceur refuse maintenant, avant même de reconstruire.

**19. Dix TIFF de 20 Mo faisaient une requête de 200 Mo.** Le découpage comptait
les fichiers, pas les octets. À 500 ko la photo c'est 5 Mo par requête ; au
format par défaut de beaucoup de scanners, c'est deux cents. 16 Mo ou dix
fichiers, le premier atteint.

**20. Vider le champ « attendu » enregistrait ZÉRO.** `Number('')` vaut zéro. Un
lot de 50 cartes affichait alors un écart de +50 et refusait de se fermer, sans
retour en arrière possible — une fois un chiffre saisi, on ne pouvait plus dire
qu'on ne savait pas.

**21. Deux écrans, deux nets différents pour le même prix.** La review calculait
son net avec **zéro** port pendant que la grille de prix en comptait un dollar.
Sur une carte à 1,75 $ : 1,11 $ contre 0,12 $. Deux conclusions opposées sur la
seule question qui compte à ce niveau de prix, affichées par la même application.

**22. Et le seuil « carte chère » existait aussi en double.** En dur dans le code
et dans la config de prix éditable. Éditer le champ ne changeait que le drapeau
de publication ; la review continuait de colorer selon l'ancienne valeur.

**23. La file de jobs aurait pris 320 Mo par an.** 258 octets par job, deux jobs
par carte, 1 700 cartes par jour — sur un quota de 500 Mo. Elle aurait fini par
coûter plus cher que les empreintes qu'elle sert à produire, pour de l'historique
que personne ne relit. Purgée à 14 jours ; les `dead` restent, c'est la trace de
ce qui a raté.

**24. Une langue contenant un tiret cassait le SKU en silence.** Le SKU se
découpe par la droite : `pt-br` ferait lire « br » en langue, « pt » en condition
et « NM » en variant. Accepté, stocké, et faux. `parseSku` valide maintenant au
lieu de caster.

**25. Un lot pouvait rester à zéro carte pour toujours.** Si la finalisation de
l'envoi échoue, les pages sont sur le disque et aucun job n'existe. L'écran
d'envoi le disait même (« ce lot contient déjà N pages ») sans que rien ne puisse
les transformer en cartes. `/batches` a maintenant un bouton **Réparer**.

**26. L'audit ne montrait que soixante lignes, les plus récentes.** Sur les huit
cents résolutions automatiques d'une journée, c'est 7 % **au hasard** — pour
l'écran dont tout le rôle est d'attraper l'erreur qui va se propager par
empreinte. Paginé, et trié par **moins sûres** : soixante lignes bien choisies
valent mieux que huit cents lues au hasard.

---

## Ce qui a été vérifié plutôt que supposé

Quatre propriétés dont tout dépendait et que rien ne testait.

**Les ressources partagées ne croisent pas leurs résultats.** La pipeline CLIP
est appelée par quatre voies en parallèle, le worker tesseract par deux. Si l'une
croisait ses résultats, une carte recevrait l'embedding ou le numéro d'une autre
— et l'embedding partirait dans `known_fingerprints`, où il servirait de vérité à
toutes les occurrences suivantes. Une erreur qui s'auto-propage, invisible.
Vérifié : six images en parallèle, chacune rend bien la sienne.

**Le niveau 1 attrape un re-scan réaliste, mais pas une carte de travers.** C'est
tout le modèle économique. Mesuré : un re-scan avec léger travers, éclairage
différent et compression reste largement sous les seuils. **À deux degrés de
travers, non** — le dHash sort (11-14 pour un budget de 10) alors que le pHash
tient encore. À surveiller au premier vrai lot : si la part `own_history` reste
basse sur un second passage des mêmes cartes, c'est l'alignement dans le bac
qu'il faut regarder, pas le seuil.

**Le seuil de ressemblance des dos tient jusqu'à trois degrés.** Il aurait pu
faire signaler *chaque* lot comme anormal. Une fixture en aplat de couleur
disait le contraire — troisième fois que ça arrive sur ce projet, c'est
maintenant écrit à côté du seuil.

**Le pipeline complet est testé de bout en bout**, sur de vraies images, dans
`pnpm test` : quatre pages recto/verso donnent deux cartes, les versos sont
rattachés, et chaque scan finit sur une issue terminale.

---

## Ce qui a changé à l'écran

| | |
|---|---|
| **Envoyer** | glisser un **dossier**, deux boutons explicites, « Cartes comptées », avertissement si le lot contient déjà des pages, et le nombre exact de pages arrivées quand un envoi casse |
| **Review** | trois colonnes — le scan, **la décision**, les réglages. Les vignettes des candidats voisins sont préchargées |
| **Prix** | l'éditeur JSON est devenu de **vrais champs** : plancher, bandes, condition, canal, garde-fous. Le JSON reste en bas, replié |
| **Vérifier** | survoler une vignette l'agrandit à 260 px — à 68 px on ne distingue pas un Set de Base d'un Set de Base 2, et c'est l'erreur que cette page existe pour attraper |
| **Diagnostic** | le taux de lecture se calcule enfin sur les scans qui ont atteint l'OCR |
| **Lots** | vider le champ « attendu » veut dire « je ne sais pas », plus « zéro » ; bouton **Réparer** pour un lot resté à zéro carte |
| **Inventaire** | « non prixé » dit maintenant **pourquoi** — printing absent, devise non convertie, aucune donnée |
| **Vérifier** | paginé, et triable par **moins sûres** |
| **Prix** | bouton **Reprixer maintenant**, au lieu d'un INSERT dans psql |
| **Santé** | deux métriques de plus (export TCGplayer, taille de la base), et deux qui ne mentent plus |

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
deux printings de la MÊME carte, base6-57            2,49 $ contre 162,00 $
six envois EN MÊME TEMPS vers le même lot           48 pages envoyées, 48 gardées
répétition par le lanceur, 25 cartes                réconciliation exacte, 0 job mort
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
pnpm course        six envois simultanés vers le même lot, rien ne doit se perdre
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
