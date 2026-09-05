# 03 — Pricing

## 1. Les sources

| Besoin | Source | Statut |
|---|---|---|
| Market price | pokemontcg.io → `tcgplayer.prices[variant].market` | gratuit, MAJ quotidienne |
| Average price | `tcgplayer.prices[variant].mid`, Cardmarket `trendPrice` | gratuit |
| Ventes eBay récentes | tcgapi.net `/v1/comps` | tier gratuit ~1 000 req/jour |

### Les deux moyennes prix + port

Le chiffre utile pour décider d'un prix eBay n'est pas le prix affiché, c'est le
**total prix + port**. Une carte à 0,99 $ avec 4,50 $ de port n'est pas une carte à
0,99 $, et comparer des prix hors port fausse toute la grille.

| Ce qu'on veut | API | Accès (vérifié 2026-09-05) |
|---|---|---|
| moyenne des totaux, annonces **actives** | Browse API `item_summary/search` | ✅ credentials applicatifs standards |
| moyenne des totaux, **ventes passées** + dates | Marketplace Insights `item_sales/search` | ⚠️ Limited Release, 90 j, réservée aux partenaires |

`lib/pricing/ebay-comps.ts` implémente les deux. Un 403 sur Insights lève
`EbayNotEntitled` et **désactive la source pour tout le batch** — inutile de brûler
500 appels voués au même refus. Le repli est alors la source tierce de l'expérience 1.

**Moyenne ET médiane sont stockées toutes les deux** (`mid` et `market` de
`price_current`). L'écart entre elles est un signal en soi : la recherche eBay est du
plein texte et ramène des lots et des cartes gradées. Un rapport moyenne/médiane de 13
veut dire qu'il faut croire la médiane.

**Le moteur consomme les ventes passées, jamais les annonces actives.** Une annonce est
un prix *demandé*, pas un prix *obtenu*. Les actives s'affichent en review pour l'œil
humain et n'entrent pas dans `estimateValue`.

**Ce qui ne marchera pas, ne perds pas de soirée dessus :** l'API officielle eBay. La
Finding API est morte et les ventes complétées sont derrière Marketplace Insights, qui
est en limited release, whitelistée par partenaire et même par catégorie. Les devs
indépendants se font refuser avec la réponse que l'accès est réservé aux gros partenaires.

**L'API TCGplayer directe non plus.** TCGplayer a cessé d'accepter les demandes
développeur publiques, et depuis le rachat par eBay l'accès reste limité aux détenteurs
de clés existants et aux partenaires approuvés. À la mi-2026 le processus est
effectivement fermé. Passe par pokemontcg.io, qui expose les points de prix TCGplayer.

**Fallbacks si tcgapi.net déçoit** (à valider dans l'expérience 1) :
- pokemonpricetracker.com — ventes eBay complétées, incluant PSA 8/9/10. Tier API à
  ~10 $/mois, 20 000 crédits/jour. Attention : leur licence commerciale est sur le plan
  Business. Usage perso = tier API correct.
- Scraper Apify — payé au résultat, fonctionne, fragile, surveille les ToS.

### Le mapping des variants

`tcgplayer.prices` est un objet dont les clés sont les printings :
`normal`, `holofoil`, `reverseHolofoil`, `1stEditionNormal`, `1stEditionHolofoil`,
`unlimitedHolofoil`. Ton `card_variant` doit mapper 1:1 dessus.

> ⚠ **Cardmarket est en EUROS, et pokemontcg.io ne convertit pas.** Vérifié sur de
> vraies cartes : Charizard Base à 897,19 $ chez TCGplayer contre 4184,60 chez
> Cardmarket, et sv1-1 à 0,11 $ contre 3,92 — des écarts de 4,7x et 35x. Ce n'est
> pas une variation de marché, c'est une unité différente doublée d'un marché
> différent. Le `cardmarket_fallback` de §2 ne doit donc **jamais publier un prix** :
> il enregistre la valeur et envoie en review, comme `no_data`. Le jour où une
> conversion de devise sera en place, cette garde pourra être levée.

**`market` peut être `null`** quand aucune annonce TCGplayer active n'existe pour ce
printing. Trois causes fréquentes : carte sans listing actif, mauvais printing demandé,
ou produit scellé. Guard partout, fallback vers `mid` puis `cm_trend`. Un `null` non
gardé qui plante un batch de 1 700 cartes à 3 h du matin, c'est ta nuit.

---

## 2. Agrégation

```ts
// lib/pricing/estimate.ts
export function estimateValue(s: PriceSources): Estimate {
  const comps = trimOutliers(s.ebaySold?.prices ?? []);   // hors 1.5 × IQR

  if (comps.length >= 3) {
    return weighted([
      [median(comps),                     0.50],
      [s.tcgMarket,                       0.35],
      [s.tcgMid ?? s.cmTrend,             0.15],
    ], { nComps: comps.length, method: 'blended' });
  }

  if (s.tcgMarket != null) {
    return weighted([
      [s.tcgMarket, 0.80],
      [s.tcgMid ?? s.tcgMarket, 0.20],
    ], { nComps: comps.length, method: 'tcg_only' });
  }

  if (s.cmTrend != null) {
    return weighted([[s.cmTrend, 1.0]], { method: 'cardmarket_fallback' });
  }

  return { value: null, method: 'no_data' };   // → review obligatoire, jamais de prix inventé
}
```

Utilise la **médiane** des comps, pas la moyenne. Une vente aberrante à 200 $ sur une
carte à 3 $ (lot mal titré, erreur d'acheteur) déplace la moyenne et pas la médiane.
Le trim IQR est une deuxième couche, pas un remplacement.

`method: 'no_data'` ne produit jamais de prix. Il envoie en review. Un système qui
invente un prix quand il ne sait pas est pire qu'un système qui s'arrête.

**Écris toujours `price_breakdown`** : sources, valeurs brutes, poids, n_comps, méthode.
Quand un prix te surprend dans six mois, tu veux voir pourquoi sans rejouer le pipeline.

---

## 3. Le moteur de règles

Config en base (`pricing_rules.config`), éditable dans l'UI sans redeploy.

```json
{
  "hard_floor": 1.75,
  "bands": [
    { "up_to": 2.00,  "mode": "floor", "value": 1.75 },
    { "up_to": 5.00,  "mode": "mult",  "value": 1.15, "round": "psych" },
    { "up_to": 20.00, "mode": "mult",  "value": 1.10, "round": "psych" },
    { "up_to": 75.00, "mode": "mult",  "value": 1.05, "round": "psych" },
    { "up_to": null,  "mode": "mult",  "value": 1.00, "round": "whole", "flag_review": true }
  ],
  "condition_mult": { "NM": 1.0, "LP": 0.85, "MP": 0.70, "HP": 0.50, "DMG": 0.30 },
  "graded_bypass": true,
  "review_threshold": 75.00,
  "reprice_delta_pct": 0.05,
  "channel_offsets": { "ebay": 1.0, "tcgplayer": 0.97 }
}
```

```ts
export function suggestPrice(
  value: number, condition: Condition, cfg: PricingConfig, channel: Channel
): number {
  const adjusted = value * cfg.condition_mult[condition];
  const band = cfg.bands.find(b => b.up_to === null || adjusted <= b.up_to)!;

  let price = band.mode === 'floor' ? band.value : adjusted * band.value;
  price *= cfg.channel_offsets[channel] ?? 1.0;
  price = Math.max(price, cfg.hard_floor);

  return round(price, band.round);   // psych → X.99 | whole → X.00
}
```

Comportement attendu, à figer en tests unitaires :

| Valeur estimée | Bande | Prix eBay |
|---|---|---|
| 0,50 $ | floor | **1,75 $** |
| 1,90 $ | floor | **1,75 $** |
| 3,00 $ | ×1,15 | **3,49 $** |
| 25,00 $ | ×1,05 | **26,49 $** |
| 120,00 $ | ×1,00, flag | **120,00 $** + review |

`channel_offsets` existe parce que TCGplayer a des acheteurs plus sensibles au prix et
un minimum de 0,40 $ sur les listings Direct. Un offset de 0,97 t'y positionne sans
dupliquer la logique de bandes.

---

## 4. La colonne qui compte : le net

```ts
export function netAfterFees(price: number, shippingCost: number, ch: Channel) {
  if (ch === 'ebay') {
    // Vérifie tes taux réels dans Seller Hub — ils varient par catégorie et par
    // niveau de vendeur, et un Store les réduit.
    return price - price * FVF_RATE - PER_ORDER_FEE - shippingCost;
  }
  return price - price * TCG_COMMISSION - shippingCost;
}
```

Affiche `net_after_fees` dans l'UI de review et dans l'éditeur de règles, en direct
quand tu bouges le plancher. À 1,75 $ avec les frais et une enveloppe, la marge est
mince à nulle. Tu veux voir le chiffre pendant que tu décides, pas au payout.

Le vrai plancher est peut-être 2,49 $. Ou peut-être que les commons sous un seuil se
vendent en lots de 10 et ne devraient jamais entrer dans le pipeline de listing
individuel. C'est une décision business, mais prends-la avec le net devant les yeux.

---

## 5. Repricing continu

Avec 12-15k SKUs actifs, le pricing est un processus, pas un événement.

```sql
-- Cron horaire, batch borné. Les chères en premier.
select sku from inventory
 where qty_on_hand > 0
   and (last_priced_at is null or last_priced_at < now() - interval '24 hours')
 order by current_price desc nulls first
 limit 500;
```

Pour chaque : rafraîchir les sources, recalculer, puis **ne pousser que si le delta
dépasse `reprice_delta_pct`**. Sans ce seuil tu génères des milliers de révisions par
jour pour des variations de quelques cents.

Ce n'est pas une limite technique — eBay permet 250 révisions par annonce par jour
civil — c'est une question de bruit, de quota d'appels et de lisibilité de ton historique.

**Garde-fous obligatoires :**

```ts
// Un mouvement de prix supérieur à 40% en un cycle = anomalie de données, pas le marché.
if (Math.abs(newPrice - oldPrice) / oldPrice > 0.40) {
  await flagForReview(sku, 'price_swing', { oldPrice, newPrice, breakdown });
  return;  // ne pousse pas
}
```

Un jour, une source va renvoyer un prix en centimes au lieu de dollars, ou un `null`
interprété comme 0. Ce garde-fou est ce qui t'empêche de lister 3 000 cartes à 0,01 $
pendant la nuit.

Écris chaque changement dans `price_history` avec un `reason`. C'est ton seul recours
pour comprendre un mois de ventes bizarres.
