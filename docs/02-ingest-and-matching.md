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

**Embedding CLIP.** `Xenova/clip-vit-base-patch32` via `@xenova/transformers`, 512
dimensions, tourne en ONNX sur CPU. Pas de GPU nécessaire, pas d'appel réseau, pas de
coût par carte. Normalise en L2 avant de stocker pour que la distance cosinus soit
propre.

**Ne change jamais de modèle sans reconstruire toute la table.** Un embedding d'un modèle
n'est pas comparable à celui d'un autre. `card_embeddings.model` existe pour t'empêcher
de mélanger.

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
  │    a) OCR du bloc numéro (tesseract sur le coin bas-gauche)
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
