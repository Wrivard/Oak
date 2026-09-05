# 04 — Canaux : eBay et TCGplayer

---

# Partie A — eBay

## A.1 Prérequis, à faire une fois avant tout code

1. Compte développeur eBay, clés production, app configurée.
2. **Opt-in aux business policies** via `optInToProgram` de l'Account API. C'est
   obligatoire pour utiliser l'Inventory API.
3. Créer les trois politiques via l'Account API v1 : **fulfillment (livraison), return
   (retour), payment (paiement)**. Les trois sont requises pour publier une annonce via
   l'Inventory API. Sans elles, `createOffer` passe et `publishOffer` échoue.
4. Créer au moins une `inventoryLocation`. Le `merchantLocationKey` n'est pas requis à
   la création de l'offre mais l'est à la publication.
5. OAuth user token avec refresh. L'access token est court, le refresh token est long
   mais fini. Stocke-le chiffré, rafraîchis proactivement, et **alerte** quand il
   approche l'expiration. Un refresh token expiré silencieusement = pipeline mort.

**Le piège de conception le plus commun** : des champs sont optionnels à la création
mais deviennent requis à la publication. La doc les note comme « Publish offer note ».
Construis un validateur `canPublish(sku)` qui vérifie tous les champs requis **avant**
d'enqueue un job de publication, plutôt que de découvrir les manques dans les erreurs
d'API à 1 700 cartes/jour.

## A.2 Le flux

```
bulkCreateOrReplaceInventoryItem   (25 items/call)
        ▼
bulkCreateOffer                    (25 offers/call)
        ▼
bulkPublishOffer                   (25 publish/call)
```

À 1 700 cartes/jour, ça fait environ 68 appels par étape, ~200 appels/jour au total.
La limite par défaut est de 5 000 appels/jour au niveau application, donc tu passes
largement. Si tu approches un jour, l'Application Growth Check est gratuit.

### Le piège qui va te mordre

`bulkCreateOrReplaceInventoryItem` fait un **remplacement complet** de la ligne. Tous
les champs actuellement définis doivent être renvoyés dans une mise à jour, qu'ils aient
changé ou non. Un champ omis est effacé.

```ts
// JAMAIS ça
await ebay.bulkCreateOrReplaceInventoryItem([{ sku, availability: { ... } }]);
// Tu viens d'effacer le titre, la description, les aspects et les images.

// TOUJOURS ça
const current = await ebay.getInventoryItem(sku);
await ebay.bulkCreateOrReplaceInventoryItem([{ ...current, availability: { ... } }]);
```

Encapsule ça dans un seul helper `updateInventoryItem(sku, patch)` qui fait le GET puis
le merge. Ne laisse aucun autre code appeler le endpoint directement.

Note aussi : une modification réussie sur une ligne d'inventaire rattachée à des annonces
actives met automatiquement à jour ces annonces. C'est pratique et c'est dangereux —
un mauvais merge se propage en production immédiatement.

## A.3 Images

- Au moins une image doit exister avant de pouvoir publier une offre.
- Les URLs doivent être en **HTTPS**. Auto-hébergement possible si ton site le supporte.
- Pour uploader un binaire, il faut passer par `UploadSiteHostedPictures` de la Trading
  API, qui retourne l'URL complète sur le serveur d'images eBay. Cette URL va ensuite
  dans `product.imageUrls`.
- Jusqu'à 24 images gratuites dans presque toutes les catégories. Tu en utilises une.

**Décision : upload via EPS, pas d'auto-hébergement.** Tu élimines une dépendance de
disponibilité (si ton storage tombe, tes annonces cassent), tu élimines le coût de
bande passante, et eBay copie de toute façon les images auto-hébergées sur ses serveurs.

L'upload EPS est **une image à la fois** — c'est ton vrai goulot d'étranglement, pas les
appels de listing. Parallélise à 4-6 workers avec retry, et rends-le idempotent : stocke
l'URL EPS retournée dans `inventory.hero_image_url` avant de faire quoi que ce soit
d'autre. Un re-upload de la même image te coûte du temps pour rien.

## A.4 Aspects et catégorie

**Ne hardcode jamais un ID de catégorie ni une liste d'aspects.**

```ts
const cat = await taxonomy.getCategorySuggestions(treeId, `${cardName} pokemon card`);
const aspects = await taxonomy.getItemAspectsForCategory(treeId, cat.categoryId);
// Construis le payload à partir de `aspects`, cache le résultat par categoryId.
```

Cache les aspects en base avec un TTL de 7 jours. Ils changent, mais pas souvent, et
tu ne veux pas un appel Taxonomy par carte.

Les aspects obligatoires refusés sont la cause numéro un d'échec de `publishOffer`.
Fais échouer ton validateur `canPublish` dessus, pas eBay.

## A.5 Titre

80 caractères, tout compte. Génère et tronque intelligemment :

```
{name} {number}/{printed_total} {set_name} {variant_label} {condition} Pokemon TCG
```

Ordre de troncature quand ça dépasse : `Pokemon TCG` → `set_name` abrégé →
`variant_label` abrégé. Ne tronque jamais le nom ni le numéro : ce sont les termes de
recherche.

Écris un test qui génère des titres pour 500 cartes réelles du catalogue et vérifie
qu'aucun ne dépasse 80 caractères et qu'aucun ne perd le numéro.

## A.6 Ventes et réconciliation

Polling `getOrders` aux 15 minutes (ou webhooks si tu les configures). Pour chaque ligne
de commande : `apply_qty_delta(sku, -qty, 'ebay_sale')`, écrire dans `channel_events`,
marquer `tcg_dirty`.

**Idempotence** : la clé est l'`orderId` + `lineItemId` d'eBay. Un poll qui rejoue les
mêmes commandes ne doit jamais décrémenter deux fois. Utilise `jobs.idempotency_key`.

**Réconciliation quotidienne** : compare `inventory.ebay_qty_pushed` avec la quantité
réelle rapportée par eBay pour chaque SKU actif. Tout écart va dans `channel_events`
avec `event = 'reconcile'` et déclenche une alerte. La dérive silencieuse entre ton
état et l'état eBay est le mode de panne le plus coûteux de ce système.

## A.7 Le coût, à valider avant de scaler

Les annonces GTC se renouvellent aux 30 jours et **chaque renouvellement recompte contre
ton allocation mensuelle**. À 15k annonces actives, tu as besoin de 15k listings gratuits
par mois en régime permanent, pas seulement pour tes nouvelles cartes.

Allocations par tier de Store : Starter 250, Basic 1 000, Premium 10 000, Anchor 25 000,
Enterprise 100 000. Au-delà, environ 0,35 $ par annonce dans la plupart des catégories.

Le détail qui décide : **l'Anchor donne 25 000 fixed price plus 75 000 annonces
additionnelles dans des catégories sélectionnées**, et cette liste inclut explicitement
`Toys & Hobbies > Collectible Card Games`. L'Enterprise ajoute 100 000 de plus.

Donc l'Anchor te couvre jusqu'à 100 000 annonces Pokémon. Compte tes SKUs uniques réels
sur ton premier vrai batch avant de choisir. Se tromper de tier à 15k annonces coûte
environ 5 000 $/mois en frais d'insertion.

---

# Partie B — TCGplayer

## B.1 Réalité de l'intégration

**Il n'y a pas d'API accessible.** Le chemin est le CSV du Seller Portal, onglet Pricing :
`Export from Live`, `Export Filtered CSV`, `Import to Staged`.

Deux contraintes bloquantes à vérifier **avant** de coder quoi que ce soit :

1. **L'import/export CSV de masse demande le statut Level 4 Seller.** Si tu n'y es pas,
   toute cette partie est inutilisable et tu restes sur eBay seul.
2. Les listings Direct ont un **prix de vente minimum de 0,40 $**.

## B.2 Le piège qui va corrompre ton inventaire

Dans le CSV d'import, la colonne de quantité est un **delta, pas une valeur absolue**.
Un entier positif ajoute à ta quantité existante, un entier négatif la réduit.

```ts
// FAUX — tu viens de doubler tout ton inventaire TCGplayer
row.addToQuantity = inv.qty_on_hand - inv.qty_reserved_tcg;

// JUSTE — le delta depuis le dernier push réussi
const target = inv.qty_on_hand - inv.qty_reserved_tcg;
row.addToQuantity = target - inv.tcg_qty_pushed;
```

C'est pour ça que `inventory.tcg_qty_pushed` existe. Il est mis à jour **uniquement**
après confirmation d'un import réussi, jamais à la génération du CSV. Si l'import
échoue, le delta suivant reste correct.

## B.3 Le mapping des IDs

TCGplayer assigne un ID unique par combinaison produit + set + **condition** + printing.
Une même carte a des IDs différents pour NM et LP.

Le seul moyen fiable d'obtenir ces IDs est de **télécharger le CSV d'inventaire depuis
leur site** ou d'exporter le catalogue filtré. Ils ne sont pas exposés sur les pages
produit.

Donc : job de seed one-shot qui télécharge un `Export Filtered CSV` par ligne de produit
Pokémon, et remplit `inventory.tcg_sku_id`. Sans ça, aucun push n'est possible. Refais-le
mensuellement pour les nouveaux sets.

C'est aussi ce qui valide ton découpage de SKU : si ton `{card_id}-{variant}-{condition}`
ne mappe pas proprement vers un `tcg_sku_id` unique, ton modèle est faux quelque part.

## B.3bis Ce qui est construit, et ce qui attend

`lib/channels/tcgplayer-csv.ts` et `worker/handlers/tcg-export.ts` sont faits et
testés. Un job `tcg_export` quotidien écrit le fichier dans `exports/`, avec une clé
d'idempotence sur la date : jamais deux fichiers pour le même jour, parce que deux
fichiers portant les mêmes deltas finiraient tous les deux uploadés.

**L'invariant est protégé par des tests.** `tcg_qty_pushed` n'avance qu'à
`confirmExport(batchId)`, appelé après un import réussi. Générer le CSV n'y touche pas.
Confirmer deux fois n'applique le delta qu'une fois — un double clic ne doit pas doubler
l'inventaire, ce qui est précisément le bug que cette colonne existe pour empêcher.

**Ce qui manque et qui vient de toi :**

1. **`tcg_sku_id` est vide pour tous les SKUs.** Ces IDs ne s'obtiennent qu'en exportant
   leur catalogue (§B.3). Sans eux, chaque ligne est écartée avec la raison
   `sans_tcg_sku_id`. C'est visible dans le log de l'export, pas silencieux.
2. **Les en-têtes du CSV sont dérivés du format documenté, pas d'un vrai fichier.** À
   confronter à un `Export Filtered CSV` réel avant le premier import : un en-tête qui
   ne correspond pas fait rejeter le fichier entier, ou pire, ignorer une colonne en
   silence.
3. **Le statut Level 4 Seller**, sans lequel toute cette partie est inutilisable.

## B.4 Automation

Deux options, dans cet ordre :

1. **CSV manuel assisté.** Ton app génère le fichier, tu l'uploades. Zéro fragilité,
   deux minutes par jour. Commence par là.
2. **Playwright headless** contre le Seller Portal, si le manuel devient pénible.

Pour l'option 2, traite ça comme du code de production, pas comme un script : profil de
navigateur persistant pour ne pas relogger à chaque run, sélecteurs par texte visible
plutôt que par classe CSS générée, screenshot systématique en cas d'échec, et **jamais
de retry aveugle sur un upload** — tu risquerais d'appliquer le même delta deux fois.

Note que le contexte est un site que tu opères avec tes propres identifiants de vendeur,
sur tes propres données. Reste dans ce cadre : rythme humain, pas de parallélisme
agressif, et relis leurs conditions d'utilisation avant d'automatiser.

---

# Partie C — Allocation entre canaux

## C.1 Le problème

Avec `qty N` sur deux canaux et un sync TCGplayer dont la latence se compte en heures,
tu **ne peux pas** lister la quantité complète des deux bords. Un stock de 8 listé à 8
partout permet d'en vendre 16.

## C.2 La règle

```ts
export function allocate(inv: InventoryRow) {
  // Sous 3 copies, le risque d'oversell dépasse la valeur de l'exposition.
  const reserveTcg = inv.qty_on_hand <= 2
    ? 0
    : Math.min(2, Math.floor(inv.qty_on_hand * 0.3));

  return {
    ebay: inv.qty_on_hand - reserveTcg,   // source de vérité, temps réel
    tcg:  reserveTcg,                     // conservateur, rafraîchi 1×/jour
  };
}
```

eBay reçoit le gros et bouge en temps réel. TCGplayer reçoit une allocation plafonnée à
2 copies et se rafraîchit quotidiennement. Tu perds un peu d'exposition, tu élimines la
classe entière des oversells.

Après chaque vente eBay : recalculer, marquer `tcg_dirty = true`. L'export quotidien
ramasse tous les dirty.

## C.3 En cas d'oversell quand même

Ça arrivera. Prépare la procédure plutôt que d'improviser :

1. Détection : `apply_qty_delta` lève une exception sur la contrainte `qty >= 0`
2. Le job échoue, `channel_events` enregistre `event = 'oversell'`
3. Alerte immédiate, pas de retry
4. Résolution manuelle : annuler la commande côté canal, ou sourcer la carte

Ne construis **jamais** de résolution automatique d'oversell. Une annulation automatique
mal déclenchée coûte plus cher en réputation vendeur que l'oversell lui-même.
