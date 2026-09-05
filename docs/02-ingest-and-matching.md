# 02 — Ingestion et matching

C'est le cœur du système. Le coût marginal par carte se décide ici.

---

## 1. Le scanner

### Réglages PaperStream IP obligatoires

| Réglage | Valeur | Pourquoi |
|---|---|---|
| Duplex | ON | recto/verso en une passe, le pairing disparaît |
| Résolution | 300 dpi couleur | ~1050×1500 px par face, largement assez pour eBay |
| Auto crop + deskew | ON | une image propre par face, zéro CV à écrire |
| Détection auto de format | ON | |
| Double-feed ultrasonique | **ON** | voir ci-dessous |
| Sortie | JPEG q90, dossier watché | |
| Nommage | `{session}_{seq:06d}_{side}.jpg` | l'ordre ADF devient `scans.seq` |

**Le double-feed est le pire bug possible du système** parce qu'il est silencieux : une
carte physique existe dans ta boîte mais n'a jamais de ligne d'inventaire. Tu la vends
pas, tu la retrouves jamais. Active la détection ultrasonique et réconcilie à chaque
session : `sessions.expected_count` (compteur du scanner) contre `sessions.scanned_count`.
Écart non nul = la session ne se ferme pas.

**Aucune penny sleeve dans l'ADF.** Ça jamme et ça peut abîmer le chemin papier.

### Deux entrées, un seul enregistrement

Le pipeline accepte les scans par **deux chemins**, et les deux passent par
`lib/ingest/register.ts` :

| Entrée | Pour qui |
|---|---|
| Watcher sur dossier | un ADF qui dépose des fichiers en continu |
| Upload navigateur (`/upload`) | des photos prises par une autre application |

Deux implémentations divergeraient sur le compteur de session ou sur l'enfilement du
job, et **un scan enregistré sans son job `fingerprint` disparaît en silence** — le pire
mode de défaillance du système. D'où la fonction unique.

**Le rang des fichiers vient du DISQUE, pas du client.** Renvoyer vers un nom de lot
déjà utilisé recommence à zéro côté navigateur, et les fichiers du premier envoi étaient
**écrasés en silence** — trois fichiers là où il devait y en avoir six, donc des cartes
physiquement scannées sans aucune trace. La route lit le rang le plus élevé déjà présent
et prend la suite. Le client envoie ses paquets séquentiellement, donc la continuation
est fiable.

### Duplex : la position apparie, l'empreinte vérifie

Un scanner duplex sort `image0001` (recto), `image0002` (verso), `image0003`… **La
position décide de l'appariement** : c'est ce que le matériel produit, et c'est simple.

L'empreinte ne décide pas, elle **contrôle**. Le dos d'une carte Pokémon est constant :
si les pages paires ne se ressemblent pas entre elles, c'est qu'une page a été perdue et
que tout le lot est décalé d'un cran. Sans ce contrôle, **chaque carte hériterait du dos
de la suivante**, en silence, et on graderait la mauvaise carte.

Le seuil de cohérence est à 80 % des pages paires. En dessous, l'anomalie est écrite
dans `channel_events` et le log passe en `warn`.

> Une première version faisait l'inverse : regrouper par ressemblance pour *déduire* les
> dos, sans se fier à la position. Trop fragile — sur des images peu détaillées le
> regroupement se trompe — et ça compliquait un problème que la position résout.
> Vérifié sur un lot de 12 pages : 6 cartes, cohérence 1,0.

L'upload demande le variant et la condition **du lot entier**, exactement comme une
session ADF : le variant ne se devine pas depuis une photo à plat (§2), et il vaut 5 à
20x d'écart de prix. Le tri physique reste en amont.

### Le watcher

N'intègre pas TWAIN/ISIS. Scan-to-folder + `chokidar` sur le dossier.

```ts
// worker/ingest/watcher.ts
// Attendre la stabilité du fichier avant de lire: le scanner écrit progressivement.
const watcher = chokidar.watch(INBOX, {
  awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
  ignoreInitial: false,   // reprend les fichiers laissés par un crash
});
```

Le watcher fait trois choses et rien d'autre : parse le nom de fichier, insère une ligne
`scans`, enqueue un job `fingerprint`. Puis il déplace le fichier vers
`processed/{session}/`. Aucun traitement d'image dans le watcher.

Redémarrage : `ignoreInitial: false` plus `unique (session_id, seq)` sur `scans` rend le
rattrapage idempotent gratuitement.

**Piège d'ordonnancement, coûté en dur.** Le watcher insère la ligne puis déplace le
fichier. Si la ligne enregistre le chemin d'`inbox/`, elle pointe sur un fichier qui
n'existe déjà plus quand le handler `fingerprint` le lit : **tous les jobs meurent sur
« image illisible »**. Écris le chemin FINAL (`processed/{session}/…`) dans `scans`,
avant de déplacer. Corollaire : un fichier manquant côté handler doit être traité comme
une erreur *ambiguë*, pas permanente — il existe une fenêtre entre le commit et le
`rename` où le chemin final n'est pas encore en place, et deux tentatives avec backoff
la couvrent.

**Les ressources partagées ne croisent pas leurs résultats.** Deux composants
sont mémoïsés en un seul exemplaire et appelés en parallèle par le worker : la
pipeline CLIP (`fingerprint`, quatre voies) et le worker tesseract (`match`, deux
voies). Si l'un des deux croisait ses résultats, une carte recevrait l'embedding
ou le numéro d'une autre — et dans le cas de l'embedding, ce vecteur partirait
dans `known_fingerprints` où il servirait de vérité à toutes les occurrences
suivantes. Une erreur qui s'auto-propage, invisible, sur le chemin censé rendre
le coût marginal nul.

C'est vérifié, pas supposé : `tests/embed-concurrence.test.ts` encode six images
une par une puis les six en parallèle et exige des vecteurs identiques à
l'arrondi près ; `tests/ocr-concurrence.test.ts` fait l'équivalent sur les
numéros.

**L'OCR est sérialisé, et il ne croise pas ses résultats.** `readCardNumbers`
partage un seul worker tesseract ; le handler `match` tourne à deux voies. Deux
cartes sont donc lues en même temps par le même worker, sur chaque lot, en
permanence. Si les résultats pouvaient se croiser, deux cartes échangeraient leur
numéro et le filtre déterministe les résoudrait **toutes les deux vers la
mauvaise carte, avec une confiance élevée** — une erreur qui ne passerait jamais
par la review. Vérifié plutôt que supposé : `tests/ocr-concurrence.test.ts` lit
six images différentes en parallèle et exige que chacune rende son propre numéro.

Conséquence de la sérialisation : les deux voies de `match` ne parallélisent que
le reste — recherche vectorielle, requêtes, écritures. Monter la concurrence
n'accélérera pas l'OCR sans un pool de workers tesseract, et chacun coûte
plusieurs dizaines de mégaoctets sur un process qui tourne déjà entre 500 et
800 Mo.

**Le taux de lecture OCR se mesure sur les scans qui ont ATTEINT l'OCR.** Trouvé
le 5 septembre 2026 : `/diagnostics` divisait par tous les scans. Or un scan
résolu au niveau 1 n'exécute jamais l'OCR — `recordOcr` n'est appelé qu'après la
tentative de niveau 2. Le taux de lecture aurait donc **baissé à mesure que la
base d'empreintes grandit**, c'est-à-dire à mesure que le système marche mieux :
on aurait lu « le niveau 2 s'effondre, il faut le redessiner » exactement quand
le niveau 1 fait son travail. Et c'est le chiffre qui décide de l'étape 3 du plan
de build.

Deux cas sautent l'OCR et se reconnaissent sans colonne dédiée :
`match_source = 'own_history'`, et le conflit de variant détecté au niveau 1, qui
part en review avant d'essayer le catalogue. L'écran affiche les deux
séparément — « N traités au niveau 1, sans passer par l'OCR — hors dénominateur »
— pour que l'écart entre les deux nombres se lise au lieu de se deviner.

**Le niveau 1 tient à l'échelle. Mesuré le 5 septembre 2026, sur 120 000
empreintes synthétiques.** La question était sérieuse : `known_fingerprints`
gagne **une ligne par scan résolu**, sans déduplication — à 25-50 000 cartes par
mois, la table dépasse 100 000 lignes en trois mois, et le niveau 1 la parcourt
en entier à chaque scan. Aucun index ne peut accélérer une distance de Hamming.

```
120 000 empreintes · balayage séquentiel parallèle
  premier appel, cache froid     633 ms
  ensuite, cache chaud        45 - 62 ms
```

Ce qui sauve la mise : le tas ne fait que **15 Mo**. La colonne `embedding`
(512 flottants) part en TOAST, hors ligne, et le balayage ne la lit jamais — il
ne touche que `phash`, `dhash` et quatre colonnes courtes. La croissance est
donc linéaire en taille de tas : à un million d'empreintes, environ 375 ms par
scan, soit une dizaine de minutes par jour à 1 700 cartes. C'est loin, et ce
n'est pas un mur.

Deux pistes testées et **rejetées** :

- *Un index couvrant* `(phash) include (dhash, card_id, …)`, pour un balayage
  d'index seul de 9 Mo au lieu du tas de 15 Mo. Mesuré : **plus lent** (64 à
  240 ms), et il aurait coûté une écriture d'index de plus sur le chemin le plus
  chaud du système. Le planificateur avait raison, l'index a été retiré.
- *Calculer les `bit_count` une seule fois via un `lateral`* au lieu de quatre
  fois dans la requête. Spectaculaire au premier essai — 622 ms contre 47 — puis
  identique une fois le cache chaud. C'était la différence entre froid et chaud,
  pas entre les deux écritures. Aucune modification de code n'était justifiée.

Si un jour ça devient un mur, la réponse n'est pas d'indexer la distance de
Hamming : c'est de **borner le nombre d'empreintes par identité**. La deux
centième occurrence du même Dracaufeu Set de Base n'apprend plus rien que les
cinq premières ne disaient déjà.

**Le niveau 1 attrape un re-scan réaliste, mais pas une carte de travers.**
C'est tout le modèle économique : la première occurrence coûte une review, les
suivantes doivent être gratuites. Mesuré le 5 septembre 2026 sur deux cartes
réelles, seuils `pHash ≤ 8` et `dHash ≤ 10` :

```
                        pHash   dHash
re-scan identique          0       0     niveau 1
recompression q75          0       0-1   niveau 1
±6 % de luminosité         0       0-1   niveau 1
recadrage 2 %              2       3-6   niveau 1
rotation 1°                4-6     4-6   niveau 1
re-scan réaliste           4       4-6   niveau 1
rotation 2°                6-8    11-14  RATÉ, repart en review
```

**Le dHash est la contrainte, et c'est la rotation qui le pousse.** Le hachage de
gradient est plus sensible au travers que celui de fréquence : à deux degrés, le
pHash tient encore (6-8 pour un budget de 8) et le dHash sort (11-14 pour 10).

Conséquence d'exploitation, à surveiller au premier vrai lot : **au-delà
d'environ un degré et demi de travers dans l'ADF, une carte déjà connue repart en
review**. Le système continue de marcher, il cesse simplement d'être gratuit sur
les répétitions — et c'est exactement ce que la métrique `own_history / catalog /
manual` du tableau de santé montrerait.

Si ça se produit, la réponse n'est pas de desserrer le seuil : à 11-14 on entre
dans la zone où des cartes différentes commencent à se ressembler (la marge
mesurée est de 29 sur la somme). C'est de redresser le scan avant de le hacher,
ou de mieux caler les cartes dans le bac. `tests/fingerprint.test.ts` porte les
deux cas en garde : un re-scan réaliste doit passer, et la sensibilité du dHash à
la rotation est documentée plutôt que découverte.

**Le seuil de ressemblance des dos tient, et la fixture qui disait le contraire
mentait.** L'appariement vérifie que les pages paires se ressemblent entre elles,
à 12 de distance de Hamming sur le pHash. Si un ADF introduisait plus de
variation que ça, **chaque lot** serait signalé comme anormal — une fausse alarme
permanente sur le contrôle censé attraper une page manquante. Mesuré sur une
image texturée, c'est-à-dire ce qu'est un vrai dos de carte :

```
rotation 0,5°   4      +8 % de luminosité   0
rotation 1°     4      recompression q60    0
rotation 2°     6      1° + lum + q70       4
rotation 3°    12
```

La même mesure sur un **aplat géométrique** donne 16 dès un degré. Une image
pauvre en détails voit son spectre DCT bouger énormément pour une petite
rotation ; une image texturée, non. C'est un piège de **fixture**, pas de seuil —
et c'est la troisième fois que des dos synthétiques en couleur unie induisent en
erreur sur ce projet. Un test qui en fabrique conclura que le seuil est trop
serré, et le desserrer masquerait le décalage d'une page.

Note au passage : quand la cohérence tombe sous 80 %, on apparie **quand même**
et on signale. Refuser d'apparier laisserait les pages sur le disque sans aucune
carte — un lot dont on ne sait plus sortir.

**Deux envois simultanés vers le même lot.** Mesuré le 5 septembre 2026, six
paquets envoyés en parallèle vers le même nom de lot :

```
avant   48 pages acceptées, 16 fichiers sur le disque, 5 lignes de session
après   48 pages acceptées, 48 fichiers sur le disque, 1 ligne de session
```

Deux défauts se cumulaient, et aucun ne se voyait.

`openSession` faisait « select puis insert » : deux requêtes concurrentes ne
trouvent rien, insèrent toutes les deux, et le lot existe en double. Les scans se
répartissent alors entre plusieurs sessions du même nom, `scanned_count` aussi, et
la réconciliation compare un comptage attendu à une fraction des cartes — le
contrôle qui existe pour rattraper une carte perdue devient faux. Corrigé par un
index unique **partiel** sur `(name) where status = 'open'` (migration 011) et
`on conflict do nothing` : réutiliser le nom d'un lot fermé reste légitime.

Le rang des fichiers venait ensuite d'une lecture du répertoire, donc deux
requêtes concurrentes écrivaient les mêmes noms et s'écrasaient. `page_count`
(migration 010) l'alloue par `update … returning`, donc atomiquement. Le rang
effectif reste le **maximum** entre ce compteur et ce que porte le disque : le
répertoire d'upload est nommé d'après le lot et non d'après son identifiant, donc
réutiliser un nom fermé ne doit pas écraser les fichiers de l'ancien.

`pnpm course` rejoue la course.

**Un fichier PRÉSENT mais indécodable écarte le scan.** Le fichier est là, il ne
se décode pas : tronqué, ou pas une image. Retenter ne le réparera pas — mais
laisser le job mourir laissait le scan en `pending` **pour toujours**, et donc le
lot impossible à clore, puisque la clôture refuse tant qu'une carte est en
traitement. Un seul fichier corrompu bloquait la réconciliation d'un lot entier.
`handleFingerprint` le marque maintenant `rejected` comme le fait `pair_upload`.

Ce cas est distinct du fichier **absent**, qui reste une erreur ambiguë avec deux
tentatives : c'est la fenêtre de course décrite juste au-dessus, et l'écarter
tout de suite perdrait une carte réelle.

**Une page illisible laisse une ligne.** Mesuré le 5 septembre 2026 : `pair_upload`
attrapait l'échec de décodage, écrivait un `log.error` et passait à la suivante. La
page disparaissait — une feuille passée physiquement dans le scanner, sans aucune ligne
en base, dont la seule trace était une entrée de journal que personne ne lit. C'est
exactement le mode de défaillance que tout le reste du système est conçu à empêcher, et
le commentaire au-dessus du code affirmait déjà qu'il ne fallait pas le faire.

`registerUnreadablePage()` écrit maintenant une ligne `rejected` : état terminal, aucun
inventaire, aucune empreinte, aucun job enfilé — mais visible dans le lot et **comptée
dans la réconciliation**, parce que la feuille est bien passée. Vérifié par
`pnpm edge` : un JPEG tronqué et un fichier texte renommé `.jpg` produisent deux lignes
écartées portant l'erreur de sharp, et zéro job mort.

**La session n'est jamais créée à la volée.** Le watcher résout `{session}` en UUID par
son nom ; si elle n'existe pas ou est fermée, le fichier part en `rejected/`, jamais
supprimé. Créer la session impliquerait de deviner `default_variant`, qui encode la
décision de pré-tri physique du foil (§2) — mal la deviner mal-étiquette un lot entier.

**L'ingestion doit être BORNÉE en concurrence.** Mesuré en test de charge : en
fire-and-forget non borné, déposer 2 000 fichiers d'un coup lance 2 000 transactions
simultanées contre un pool de 10 connexions. **1 849 ont expiré sur « timeout exceeded
when trying to connect » et les fichiers ont été abandonnés en silence dans l'inbox.**
Le worker lui-même s'est retrouvé affamé de connexions et n'arrivait plus à réclamer
ses jobs.

C'est le pire mode de défaillance de tout le système : une carte physique sans ligne
d'inventaire, exactement ce que la réconciliation de session existe pour rattraper. Et
un ADF à 60 pages/minute produit précisément ce genre de rafale.

La file d'ingestion de `worker/ingest/watcher.ts` limite à 4 en parallèle, retente
3 fois, puis déplace le fichier en `rejected/_echec_ingestion/` — **visible**, jamais
abandonné là où personne ne le reverra. Le débit n'est pas perdu : la base est de toute
façon le goulot, et la sérialiser proprement va plus vite que la saturer puis échouer.

**Le compteur de session s'incrémente à l'insertion, pas à chaque fichier vu.** Sans ça,
un rattrapage au redémarrage sur-compterait `scanned_count` et masquerait précisément
l'écart de double-feed qu'on cherche à détecter.

---

## 2. Le problème du foil — à régler avant de coder

Un scanner de documents a une source lumineuse uniforme et mobile. Le shimmer qui
distingue un reverse holo d'un normal disparaît presque entièrement. Sur la même carte
c'est souvent 5 à 20x d'écart de prix.

**Décision : pré-tri physique + `sessions.default_variant`.** La session porte le
variant, le scan l'applique, la vision ne décide pas. Trier à la main est plus rapide
que corriger 5 000 annonces mal prisées.

**Détecteur de désaccord.** Si le matching penche fortement vers un variant différent du
défaut de session, mets `scans.variant_conflict = true` et envoie en review. Ça attrape
les cartes mal triées sans dépendre d'une détection de foil fiable.

Si l'expérience 0 (voir `PROMPTS.md`) montre que le foil *est* distinguable dans tes
scans, tu pourras relâcher le pré-tri. Ne présume pas que oui.

---

## 3. Empreintes : pourquoi deux techniques

La recherche est claire sur le compromis. Le hachage perceptuel est quasi parfait et
extrêmement rapide pour l'identification de duplicatas exacts, mais s'effondre dès qu'il
y a des transformations géométriques comme la rotation ou le recadrage, ou des
variations de luminosité. Les embeddings CNN restent solides partout mais généralisent :
ils rapprochent des images *similaires*, pas *identiques*.

Ton cas coupe la poire exactement :

| Comparaison | Conditions | Technique |
|---|---|---|
| Ton scan vs **tes scans passés** | même scanner, même éclairage, même deskew → quasi-duplicata exact | **pHash + dHash** |
| Ton scan vs **image catalogue** | render officiel vs scan physique → transformation majeure | **CLIP** |

Utilise les deux hachages, pas un seul. Des cartes différentes peuvent partager de
l'information fréquentielle similaire ; croiser pHash (DCT) et dHash (gradient) fait
tomber les faux positifs.

**Bonus du duplex** : le dos d'une carte Pokémon est constant. Hache-le. Un pHash de dos
qui ne matche pas la référence connue signale une carte insérée à l'envers ou de travers.
Deux lignes de code, ça attrape une classe entière d'erreurs d'alimentation.

### Implémentation

```ts
// worker/fingerprint/hash.ts
// pHash 64 bits: grayscale → 32×32 → DCT-II → 8×8 coin basse fréquence
//                → médiane → bits. dHash: 9×8 → comparaison horizontale.
// Distance de Hamming via bit_count(a # b) en Postgres.
```

```sql
-- Recherche par Hamming, exacte et rapide sur bit(64).
-- Retourne les COMPOSANTES d'identité, pas un SKU : known_fingerprints ne connaît
-- pas l'inventaire. Le worker dérive le SKU avec buildSku(). Voir docs/01.
select card_id, variant, condition, language,
       bit_count(phash # $1) as d_p, bit_count(dhash # $2) as d_d
  from known_fingerprints
 where bit_count(phash # $1) <= 12
 order by d_p + d_d
 limit 5;
```

### Séparation mesurée, pas supposée

Sur **741 paires de cartes distinctes** (39 cartes réelles, hachées avec
l'implémentation de `lib/fingerprint/hash.ts`) :

| | min | p1 | p5 | médiane | max |
|---|---|---|---|---|---|
| pHash seul | 10 | 16 | 20 | 30 | 48 |
| dHash seul | 10 | 14 | 18 | 28 | 47 |
| **somme** | **29** | 35 | 41 | 58 | 89 |

L'intuition « deux cartes différentes sont à 20 ou plus » est **fausse hachage par
hachage** : 3,4 % des paires passent sous 20 en pHash, 8,4 % en dHash. Elle n'est vraie
que sur la somme, jamais descendue sous 29.

C'est la justification chiffrée du `order by d_p + d_d` ci-dessus, et la marge du
niveau 1 est confortable : le seuil d'acceptation est `phashMax 8 + dhashMax 10 = 18`,
soit onze points sous le pire cas observé entre deux cartes différentes.

Côté stabilité, une même image redimensionnée à 80 % donne une distance de 0 (pHash)
et 1 (dHash) — le hachage est robuste au rééchantillonnage, ce qui est exactement le
régime « ton scan vs tes scans passés ».

**Embedding CLIP.** `Xenova/clip-vit-base-patch32` via `@xenova/transformers`, 512
dimensions, tourne en ONNX sur CPU. Pas de GPU nécessaire, pas d'appel réseau, pas de
coût par carte. Normalise en L2 avant de stocker pour que la distance cosinus soit
propre.

**Ne change jamais de modèle sans reconstruire toute la table.** Un embedding d'un modèle
n'est pas comparable à celui d'un autre. `card_embeddings.model` existe pour t'empêcher
de mélanger.

**Piège d'installation, vérifié en dur.** `@xenova/transformers` 2.17 dépend de
`sharp@^0.32`, alors que le projet utilise `sharp` 0.35. Les deux chargent un binaire
libvips natif, et charger les deux dans le même process fait **segfaulter Node** — sans
message d'erreur exploitable, juste des `GLib-GObject-CRITICAL` puis un crash. Le
`pnpm.overrides` sur `sharp` dans `package.json` force une version unique. Ne le
retire pas : le worker a besoin des deux bibliothèques dans le même process.

Mesures sur cette machine, CPU seul : **~25 ms par embedding** une fois le modèle
chargé (~2 s au premier appel), soit ~20 cartes/s bout en bout avec le téléchargement
des images.

---

## 4. Résolution en trois niveaux

```
scan → hash + embed (0 $, local, ~80 ms)
  │
  ├─ NIVEAU 1 — known_fingerprints (tes scans confirmés)
  │    hamming(pHash) ≤ 8 ET hamming(dHash) ≤ 10
  │    → résolu, match_source = own_history. Incrémente qty. FIN.
  │
  ├─ NIVEAU 2 — catalogue
  │    a) OCR du bloc numéro (tesseract, plusieurs bandes — voir ci-dessous)
  │       si "X/Y" lisible → filtre déterministe:
  │         where printed_total = Y and number = X and language = L
  │         fallback: where total = Y (secret rares)
  │       → typiquement 1-4 candidats
  │    b) rerank par distance cosinus contre card_embeddings
  │    c) 1 candidat ET cos_dist < 0.15 ET pas de variant_conflict
  │       → résolu, match_source = catalog
  │
  └─ NIVEAU 3 — review manuelle
       status = needs_review, avec les candidats du niveau 2 pré-affichés.
       Résolution confirmée → écrit dans known_fingerprints.
```

### Où est le bloc numéro : nulle part de fixe

Le doc disait « coin bas-gauche ». C'est vrai sur le moderne et **faux sur le vintage** :
sur les cartes Base, le numéro est en bas à **droite**. Mesuré, pas supposé — un crop
bas-gauche unique lit 0 carte sur 7, toutes ères confondues.

L'idée du crop « era-aware » se mord la queue : on ne connaît l'ère qu'une fois la carte
identifiée, et c'est justement ce qu'on cherche à faire. La sortie est de renverser
l'ordre : **l'OCR propose, le catalogue arbitre.**

`readCardNumbers()` essaie chaque bande de `THRESHOLDS.ocr.bands` dans l'ordre et rend la
main dès qu'une lecture produit des candidats réels. Une lecture erronée — `5/4`,
`1/195` — ne correspond à aucune carte et s'élimine d'elle-même, sans heuristique de
mise en page.

| Bande essayée | Couvre |
|---|---|
| bas 12 %, moitié gauche | moderne (SV, SM, XY) |
| bas 12 %, moitié droite | vintage (Base) |
| bas 12 %, pleine largeur | filet |
| bas 20 %, pleine largeur | promos, e-Card |

**Résultat sur les renders officiels : 7 lectures correctes sur 10**, contre 0 avec le
crop unique. Les trois échecs sont Neo, e-Card et une promo.

> ⚠ **Ce n'est pas l'expérience 1bis.** Ces mesures portent sur les images officielles du
> catalogue, pas sur des scans ADF à 300 dpi. Le domaine est différent — bruit,
> éclairage, deskew. Ne calibre pas les seuils là-dessus : ce serait sur-ajuster sur les
> mauvaises images. 1bis reste entièrement à faire, sur de vrais scans.

### Quand l'OCR ne lit rien

Sans `X/Y`, le filtre déterministe n'a rien sur quoi mordre et la carte part en review.
Le handler remonte quand même les cinq plus proches voisins CLIP du catalogue entier
(index HNSW) dans `scans.candidates`.

Ça ne résout **jamais** automatiquement — sans le filtre, rien ne garantit que le bon
candidat soit seulement dans la liste. Mais ça évite à la review de partir d'une page
blanche, et c'est là qu'est le coût réel du système.

**Ce que le filtre déterministe fait réellement — mesuré sur les 20 444 cartes
anglaises seedées (2026-09-04), pas estimé :**

| Candidats retournés | % des cartes |
|---|---|
| 1 | 45,4 % |
| 2 | 32,4 % |
| 3 | 9,5 % |
| 4 | 11,4 % |
| 6 et plus | 1,3 % |

Le filtre **réduit, il ne résout pas.** 98,7 % des cartes tombent bien dans la
fourchette 1-4 annoncée, mais seulement 45 % sortent avec un candidat unique. Exemple
canonique : `printed_total = 102 and number = '4'` retourne trois cartes de trois
époques — Charizard (Base, 1999), Drapion (HS—Triumphant, 2010), Mimikyu ex (promo SVP,
2023), parce que trois sets partagent le même dénominateur imprimé.

**Conséquence directe :** le rerank CLIP est sur le chemin critique dès la première
carte, pour plus de la moitié du volume. Ce n'est pas un raffinement de second ordre.
La qualité des embeddings (étape 3) et la marge minimum entre 1er et 2e candidat
(`THRESHOLDS.catalog.minMargin`, étape 5) déterminent à eux seuls le taux de review
manuelle. Le test `tests/catalog.test.ts` garde ce chiffre : il échoue si un refresh du
catalogue fait passer la part 1-4 candidats sous 98 %.

### Ce que le rerank CLIP rattrape, mesuré

Embeddings calculés pour 20 392 des 20 444 cartes (52 images mortes chez l'hébergeur).
Sur les **19 106 paires de cartes qui partagent le même `(printed_total, number)`** —
donc celles que le filtre déterministe présente ensemble :

| | paires | part |
|---|---|---|
| séparées proprement par CLIP (`d ≥ 0,15`) | 18 126 | 94,9 % |
| dans la zone d'acceptation (`d < 0,15`) | 980 | 5,1 % |
| indissociables (`d < 0,06`, sous `minMargin`) | 18 | 0,09 % |

Distance minimale observée : 0,0178.

**Les 18 paires indissociables sont toutes des Énergies de base** rééditées à l'identique
entre Gym Heroes et Gym Challenge. Des cartes à 0,10 $. L'ambiguïté résiduelle se
concentre exactement là où elle n'a aucune valeur marchande — ne les envoie pas en review
manuelle, prends le premier candidat et passe à la suivante.

**Contre-exemple utile : les rééditions ne sont pas le problème qu'on croit.** Le
Charizard Base est à 0,048 de celui de Base Set 2 et 0,054 de celui de Legendary
Collection — CLIP seul ne les séparerait jamais. Mais leurs dénominateurs diffèrent
(102, 130, 110), donc le filtre déterministe les a déjà écartés avant le rerank. Les
deux étages se couvrent l'un l'autre : le filtre sépare ce que CLIP confond, CLIP sépare
ce que le filtre regroupe.

**Index HNSW.** 53 Mo pour 20 392 vecteurs. `EXPLAIN ANALYZE` sur une requête de
similarité montre bien `Index Scan using card_embeddings_hnsw`, jamais de Seq Scan.

Chaque carte confirmée renforce le niveau 1. Après quelques milliers de cartes, ton taux
de non-résolu devrait tomber sous 5 %.

**Le seed compte plus que tout.** Passe tes 2 000 premières cartes en review manuelle
complète, et écris chaque confirmation dans `known_fingerprints`. C'est l'investissement
qui rentabilise le reste du système.

### Seuils

Mets-les dans un fichier de config, pas en dur. Ils devront être calibrés sur tes vraies
données, et la valeur correcte dépend de ton scanner.

```ts
export const THRESHOLDS = {
  ownHistory:  { phashMax: 8,  dhashMax: 10 },
  catalog:     { cosineMax: 0.15, minMargin: 0.06 },  // marge vs 2e candidat
  autoAccept:  { maxValue: 20.00 },
  hardReview:  { minValue: 75.00 },
};
```

`minMargin` est le garde-fou important : un candidat à 0.14 avec un deuxième à 0.145 est
une **ambiguïté**, pas un match. Exiger un écart entre le premier et le deuxième attrape
les cartes qui se ressemblent (mêmes artwork réimprimés, promos).

---

## 5. Niveau 3 — la review manuelle

**Il n'y a pas de fallback automatique.** Aucun appel Claude API n'est autorisé dans ce
projet (voir `CLAUDE.md`). Un scan qui sort du niveau 2 sans candidat unique part en
`needs_review`.

### Pourquoi pas un LLM

Un LLM ne donnerait pas de capacité ici, seulement du temps. Ce qu'il ferait, c'est
départager 1 à 4 candidats **déjà filtrés par le niveau 2** — soit environ 3 secondes
de travail pour un humain qui regarde la carte qu'il a dans les mains. À 5 % de 1 700
cartes par jour, l'automatisation sauverait 4 minutes par jour.

Et le calcul est pire qu'il n'en a l'air : pendant la phase où le taux de fallback est
élevé — les premiers milliers de cartes, avant que `known_fingerprints` soit seedé —
tout passe en review manuelle de toute façon, précisément pour seeder les empreintes.
Le LLM n'apporterait donc rien exactement là où il aiderait le plus.

`PROMPTS.md` étape 8 est le point où on relit cette décision avec des chiffres réels.

### Ce que le niveau 3 doit fournir à la place

Le levier n'est pas l'automatisation, c'est le **temps par carte en review**. L'UI de
review (étape 6) est donc un composant du chemin critique, pas un accessoire :

- Les candidats du niveau 2 pré-affichés, image officielle côte à côte avec le scan.
- Résolution au clavier seul, sans souris. Un chiffre pour choisir un candidat.
- La recherche plein texte n'est ouverte que si aucun candidat ne convient.
- Toute résolution écrit dans `known_fingerprints` avec `confirmed_by = 'manual'`.

La valeur `'llm'` reste dans l'enum `match_source` et la colonne `scans.llm_raw`
existe : coût zéro, porte ouverte si la décision de l'étape 8 change un jour.

### Ce que le niveau 2 doit garantir

Puisqu'il n'y a plus de filet payant en dessous, la qualité de l'OCR du numéro devient
critique — un échec OCR n'envoie plus vers un fallback, il envoie directement en review
manuelle. D'où l'expérience 1bis de `PROMPTS.md`, à faire **avant** l'étape 3.

---

## 6. Photos

**Une seule photo par SKU, capturée au premier scan.**

```
scan résolu → SKU existe déjà avec hero_image_url
   → jette les deux fichiers, apply_qty_delta(+1). Rien à uploader.

scan résolu → nouveau SKU
   → front: resize 1600px côté long, JPEG q80 (~200-300 KB) → upload eBay EPS
   → back:  sert au grading auto, puis supprimé
```

Le dos d'une carte Pokémon est uniforme. Zéro information pour l'acheteur. Mais le
whitening sur la bordure bleue est exactement comment on grade la condition. Duplex pour
le grading interne, front seulement vers eBay.

N'archive jamais les originaux 300 dpi. Une fois l'URL eBay obtenue, supprime le local.

**Mention obligatoire dans la description quand `qty_on_hand > 1`** : la photo est
représentative, l'acheteur reçoit une carte de la même condition, pas celle photographiée.
Sans ça, tu manges des retours et des cas INAD.

---

## 7. Lane manuelle (slabs)

Une slab PSA ne passe pas dans l'ADF. Chemin séparé :

1. Photo au téléphone, upload direct dans l'UI
2. OCR du numéro de cert sur le label
3. API PSA (`api.psacard.com`, token gratuit, rate-limité) → nom, set, grade, population
4. Toujours `qty = 1`, toujours un SKU unique, **toujours review humaine**

C'est le chemin le plus fiable du système : le cert est un identifiant exact. Exploite-le
plutôt que de faire deviner la vision.

Cache les réponses PSA en base — le rate limit est serré et un cert ne change jamais.
