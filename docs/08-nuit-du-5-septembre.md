# Ce qui a été fait pendant la nuit du 5 septembre

Résumé de la session autonome. À lire avant de commencer les tests — surtout les
sections **Bugs trouvés** et **Ce qui ne marchera pas**.

> **Il y a une suite : `docs/09-matinee-du-5-septembre.md`.** Elle contient vingt et une
> pannes de plus, dont deux qui te concernent directement — le lanceur ne
> démarrait pas le worker, et ta base Supabase a une limite de trois à cinq
> mois. Lis-la après celle-ci.

**Départ :** 164 tests, 4 écrans, pas de coquille d'application.
**Arrivée :** 196 tests, 8 écrans, une vraie app.

---

## Les écrans, dans l'ordre où tu les utiliseras

| | Ce qui a changé |
|---|---|
| **Envoyer** | appariement recto/verso duplex, envoi par paquets, progression |
| **Lots** | **nouveau** — ce que devient chaque envoi, clôture avec réconciliation |
| **Review** | images des candidats, numéro OCR affiché, `?` aide, `R` écarter |
| **Vérifier** | **nouveau** — auditer ce que la machine a décidé seule |
| **Inventaire** | **nouveau** — ce que tu possèdes, filtres, recherche, valeur totale |
| **Prix** | inchangé sur le fond, refait sur la forme |
| **Diagnostic** | **nouveau** — l'expérience 1bis en continu |
| **Santé** | une sixième métrique : le worker draine-t-il ? |

Tout vit maintenant dans une **coquille commune** : barre latérale, en-tête, corps
défilant. Elle se réduit d'elle-même sur `/review`, la page qui a besoin de la largeur.

---

## Les six bugs trouvés en testant

Aucun n'est venu d'une relecture. Tous sont venus de l'exécution.

**1. Un second envoi vers le même lot écrasait le premier.** Trois fichiers là où il
devait y en avoir neuf. Des cartes physiquement scannées **sans aucune trace** — et
même le compteur de réconciliation ne l'aurait pas vu, puisque les scans n'étaient
jamais créés. Le rang vient maintenant du disque.

**2. Le pooler Supabase est limité à 15 connexions.** Deux process à 10 chacun font 20.
Sous charge, l'app et le worker s'affamaient mutuellement — et `psql` ne pouvait même
plus se connecter pour diagnostiquer, ce qui est comment je l'ai découvert. Symptôme :
`/batches` à **2,2 secondes**. J'ai d'abord soupçonné la requête ; mesurée, elle prenait
0,4 ms. Après bornage : **64 ms**.

**3. `revalidatePath` dans le `try` qui décide du succès.** Une correction d'inventaire
réussissait — transaction commitée — puis la revalidation échouait et l'action rapportait
un échec. Un utilisateur qui réessaie aurait **décrémenté la quantité deux fois**.

**4. `/pricing` renvoyait 500 depuis l'étape 7.** Un `ntile()` imbriqué, que Postgres
refuse. Je ne l'avais pas vu parce que j'avais vérifié que la page *compilait* sans
jamais la *charger*. Un build vert n'est pas une page rendue.

**5. `Demarrer.bat` ne reconstruisait que si `.next` était absent.** Après chaque mise à
jour du code il servait donc un build périmé — c'est pourquoi tu voyais encore l'ancienne
interface. Il reconstruit maintenant à chaque démarrage, sept secondes.

**6. `timeout /t` casse quand l'entrée standard est redirigée.** Remplacé par `ping`.
Trouvé en exécutant le lanceur pour de vrai, pas en le relisant.

---

## Ce qui a été mesuré

```
400 pages (178 Mo) uploadées        8 s
appariement 400 pages -> 200 cartes cohérence 1,0, zéro anomalie
200 cartes traitées                 149 s, soit 80 cartes/min
800 cartes, 4 lots, un seul worker  725 -> 806 -> 525 -> 518 Mo
```

**La mémoire ne fuit pas** : elle oscille entre 500 et 800 Mo et redescend. Le poids
vient de CLIP et d'onnxruntime, pas de sharp — mesuré, la concurrence de sharp ne change
ni la vitesse ni la mémoire, de 1 à 24 threads. Je n'ai donc rien « optimisé » là où il
n'y avait rien.

**La boucle d'apprentissage tient à l'échelle** : le second lot identique a résolu
exactement les 81 mêmes cartes en `own_history`.

---

## Trois choses à savoir avant de tester

**L'audit existe pour une raison.** Le système va résoudre une bonne part de tes cartes
tout seul. Une résolution fausse ne se trompe pas qu'une fois : elle écrit une
**empreinte**, et toutes les occurrences suivantes hériteront de la même erreur par le
niveau 1. Le bouton « c'est faux » supprime l'empreinte fautive — c'est le point qui
compte, plus que la quantité.

**Le variant se décide à l'envoi.** Une photo à plat ne distingue pas un reverse holo
d'un normal, et c'est 5 à 20 fois d'écart de prix. Trie-les à part, fais-en un lot séparé.

**Si le worker s'arrête, l'app te le dit** sur toutes les pages, avec la commande à
relancer. C'est la panne la plus probable : on ferme la fenêtre sans y penser.

---

## Ce qui ne marchera pas, et c'est normal

- **Aucun prix eBay réel** — `fetchEbayComps()` rend une liste vide tant que la source
  de ventes passées n'est pas choisie (expérience 1). Le pricing tourne sur TCGplayer.
- **Le net est une estimation** — taux de frais non vérifiés, étiquetés comme tels.
- **L'export TCGplayer écarte tout** — `tcg_sku_id` est vide.
- **La porte de non-régression du matching est inactive** — le golden set est vide.
  `pnpm golden:export` le constitue à partir de tes reviews ; vérifié, il récolte bien.

---

## Par où commencer

`docs/07-premier-test.md` — six tests dans l'ordre, chacun produisant la donnée dont le
suivant dépend. Le test 2 est celui qui décide de la suite : le taux de lecture OCR sur
`/diagnostics`.

Double-clique `Demarrer.bat`.
