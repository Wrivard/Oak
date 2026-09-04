---
name: money-path
description: Use when writing or modifying any code that touches prices, quantities, fees, channel allocation, or the TCGplayer CSV. Covers the tests-first requirement, the no-invented-price rule, the price-swing guard, decimal handling, and the delta-not-absolute quantity rule that corrupts inventory. Apply before integrating, not after.
---

# Money path — politique

Détail : `docs/03-pricing.md` et `docs/04-channels.md` parties B et C.

Ce skill est une politique, pas un tutoriel. Les règles ci-dessous ne se négocient pas
pour aller plus vite.

## 1. Tests avant intégration

Toute fonction qui touche l'argent a des tests unitaires **avant** d'être appelée par
autre chose. Ça bloque le merge.

Cas limites obligatoires, pas seulement le chemin heureux :
- valeur `null`, valeur négative, valeur zéro
- valeur exactement sur une frontière de bande (2.00, 5.00, 20.00, 75.00)
- condition inconnue
- 0, 1, 2, 3 puis 10 comps
- toutes les sources à `null`

## 2. Jamais de prix inventé

`estimateValue` retourne `method: 'no_data'` quand il n'a rien. Ce cas **n'produit
jamais de prix** — il envoie en review. Un système qui devine quand il ne sait pas est
pire qu'un système qui s'arrête.

`market` peut être `null` légitimement (aucun listing actif, mauvais printing, produit
scellé). Guard partout, fallback vers `mid` puis `cm_trend`. Un `null` non gardé qui
plante un batch de 1 700 cartes à 3 h du matin, c'est la nuit.

## 3. Garde-fou de variation

```ts
if (Math.abs(newPrice - oldPrice) / oldPrice > 0.40) {
  await flagForReview(sku, 'price_swing', { oldPrice, newPrice, breakdown });
  return;  // ne pousse pas
}
```

Un jour une source renverra des centimes au lieu de dollars, ou un `null` interprété
comme 0. Ce garde-fou est ce qui empêche de lister 3 000 cartes à 0,01 $ pendant la nuit.

## 4. Médiane, pas moyenne

Les comps eBay se réduisent par **médiane** après trim IQR. Une vente aberrante (lot
mal titré, erreur d'acheteur) déplace la moyenne et pas la médiane. Le trim est une
deuxième couche, pas un remplacement.

## 5. Décimales

`numeric` en base, cents entiers en TypeScript pour tout calcul cumulatif. Pas de
float qui s'accumule. Arrondi seulement à l'affichage et au push final.

## 6. La quantité TCGplayer est un DELTA

Dans le CSV d'import, la colonne quantité s'ajoute à l'existant. Un positif ajoute, un
négatif retire.

```ts
// ❌ double tout l'inventaire au premier import
row.addToQuantity = inv.qty_on_hand - inv.qty_reserved_tcg;

// ✅ delta depuis le dernier push confirmé
const target = inv.qty_on_hand - inv.qty_reserved_tcg;
row.addToQuantity = target - inv.tcg_qty_pushed;
```

`tcg_qty_pushed` se met à jour **uniquement après confirmation d'import réussi**, jamais
à la génération du CSV. Si l'import échoue, le delta suivant reste correct.

Test obligatoire : séquence `push(8) → vente(2) → push`. Le second delta doit être `-2`.

## 7. Traçabilité

Chaque changement de prix écrit dans `price_history` avec `reason` et le `breakdown`
complet (sources, valeurs brutes, poids, n_comps, méthode). Sans ça, le runbook « des
prix aberrants sont partis en prod » est inexécutable.

## 8. Le net, toujours affiché

`netAfterFees` s'affiche dans l'UI de review et dans l'éditeur de règles, en direct
quand on bouge le plancher. Une décision de plancher se prend avec le net devant les
yeux, pas au payout.

## Interdits

- Intégrer une fonction de pricing sans ses tests
- Produire un prix quand `method === 'no_data'`
- Pousser un prix qui bouge de plus de 40 % en un cycle
- Écrire une quantité absolue dans le CSV TCGplayer
- Mettre à jour `tcg_qty_pushed` avant confirmation
- Résoudre un oversell automatiquement — alerte et arrêt, résolution manuelle
