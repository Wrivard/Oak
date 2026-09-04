---
name: card-matching-thresholds
description: Use when changing any matching threshold, embedding model, hash algorithm, or resolution logic in the three-tier card identification pipeline. Enforces the golden set regression gate and the embedding model consistency rule. Apply before merging any change that could shift which cards resolve automatically.
---

# Matching — porte de non-régression

Détail : `docs/02-ingest-and-matching.md` §3 et §4.

## 1. La porte

Aucun changement de seuil, de modèle ou de logique de résolution ne se merge sans que
`tests/golden.test.ts` passe.

Deux conditions, les deux doivent tenir :
- la précision ne descend pas sous la ligne de base
- le taux de fallback LLM ne monte pas de plus de 2 points

Un seuil qui règle le cas que tu regardes en casse cinquante que tu ne regardes pas.
Le golden set est la seule protection contre ça.

Si le golden set est vide ou trop petit (moins de 200 scans étiquetés), dis-le et
n'ajuste pas les seuils. Constituer le jeu passe avant l'optimisation.

## 2. Les seuils vivent dans un seul fichier

`lib/config/thresholds.ts`. Jamais de valeur numérique de seuil ailleurs dans le
codebase. Si tu en trouves une en dur, remonte-la.

## 3. La marge compte autant que le seuil

Un candidat à `cos_dist = 0.14` avec un deuxième à `0.145` est une **ambiguïté**, pas
un match. Le niveau 2 exige `minMargin` entre le premier et le deuxième candidat, en
plus du seuil absolu. Ne retire jamais cette condition pour augmenter le taux
d'auto-résolution : c'est ce qui attrape les artworks réimprimés et les promos.

## 4. Deux techniques, deux usages — ne les interverti pas

| Comparaison | Conditions | Technique |
|---|---|---|
| scan vs scans passés | même scanner, même éclairage → quasi-duplicata | **pHash + dHash** |
| scan vs image catalogue | render officiel vs scan → transformation majeure | **CLIP** |

Le hachage perceptuel est quasi parfait sur les duplicatas exacts et s'effondre sur les
transformations géométriques et les variations de luminosité. Les embeddings CNN
restent solides partout mais généralisent — ils rapprochent des images *similaires*,
pas *identiques*.

Utilise les deux hachages, jamais un seul : des cartes différentes peuvent partager de
l'information fréquentielle, croiser pHash (DCT) et dHash (gradient) fait tomber les
faux positifs.

## 5. Cohérence du modèle d'embedding

Un embedding d'un modèle n'est **pas comparable** à celui d'un autre. Changer de modèle
impose de reconstruire `card_embeddings` **et** `known_fingerprints` en entier.

`card_embeddings.model` existe pour empêcher le mélange. Vérifie-le avant toute
comparaison. Si tu changes de modèle, c'est une migration, pas un patch.

## 6. Le variant ne se devine pas

Le scan à plat écrase le reflet du foil. Le variant vient de
`sessions.default_variant`, pas de la détection.

`variant_conflict` force `needs_review` peu importe la confiance. Ne le contourne
jamais pour augmenter l'auto-publish : reverse holo vs normal, c'est 5 à 20x d'écart
de prix.

## 7. Chaque confirmation nourrit le système

Toute résolution confirmée — manuelle, catalogue ou LLM — écrit dans
`known_fingerprints`. C'est le mécanisme qui fait tendre le coût marginal vers zéro.
Un chemin de résolution qui n'écrit pas dans cette table est un bug.

## 8. Métrique à surveiller

La répartition `own_history / catalog / llm / manual` est la métrique économique
principale du projet. Elle devrait descendre côté LLM avec le temps, jamais monter.

Si elle monte, les causes par ordre de probabilité : nouveau set absent de `cards`,
réglages du scanner modifiés, seuils touchés sans passer le golden set.

## Interdits

- Merger un changement de seuil sans golden set vert
- Un seuil en dur hors de `lib/config/thresholds.ts`
- Retirer la condition de marge minimum
- Comparer des embeddings de modèles différents
- Contourner `variant_conflict`
- Un chemin de résolution qui n'alimente pas `known_fingerprints`
