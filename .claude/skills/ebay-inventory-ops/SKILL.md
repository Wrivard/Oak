---
name: ebay-inventory-ops
description: Use when touching any eBay Sell API code — inventory items, offers, publishing, EPS image upload, category aspects, OAuth tokens, or order polling. Contains destructive-operation guards and publish-time requirements that are not obvious from the eBay docs and that silently corrupt live listings.
---

# eBay Inventory API — garde-fous

Détail complet : `docs/04-channels.md` partie A. Ce skill contient les règles qui
cassent la production si on les rate. Lis le doc pour le reste.

## 1. Le remplacement complet (destructeur)

`bulkCreateOrReplaceInventoryItem` remplace **toute** la ligne. Un champ omis est
effacé. Et une modification réussie se propage **immédiatement** aux annonces actives.

```ts
// ❌ efface titre, description, aspects et images
await ebay.bulkCreateOrReplaceInventoryItem([{ sku, availability }]);

// ✅ le seul chemin autorisé
await updateInventoryItem(sku, { availability });   // GET → merge → PUT
```

**Règle absolue :** un seul helper `updateInventoryItem(sku, patch)` fait le GET puis
le merge. Aucun autre fichier n'appelle `bulkCreateOrReplaceInventoryItem` ni
`createOrReplaceInventoryItem` directement. Si tu es sur le point d'en écrire un
deuxième appel, arrête-toi et utilise le helper.

## 2. Valider avant d'enqueue, pas après

Des champs sont optionnels à la création mais requis à la publication (la doc eBay les
marque « Publish offer note »). À 1 700 cartes/jour, découvrir les manques dans les
erreurs d'API est ingérable.

Toute publication passe par `canPublish(sku)` qui vérifie au minimum :
`merchantLocationKey`, au moins une `imageUrl` en HTTPS, `availability.quantity`,
`categoryId`, les trois listing policies, et tous les aspects obligatoires de la
catégorie. Échec → `needs_review`, pas de job enqueued.

## 3. Prérequis de compte (à vérifier avant de débugger une erreur de publication)

- Opt-in aux business policies via `optInToProgram` de l'Account API. Obligatoire pour
  utiliser l'Inventory API.
- Les trois politiques fulfillment, return, payment doivent exister. Sans elles,
  `createOffer` passe et `publishOffer` échoue.
- Au moins une `inventoryLocation`.

Si `publishOffer` échoue et que le message est cryptique, vérifie ces trois points
avant de chercher dans le code.

## 4. Aspects et catégorie

Ne hardcode **jamais** un `categoryId` ni une liste d'aspects. Toujours
`getCategorySuggestions` puis `getItemAspectsForCategory`, avec cache en base TTL 7
jours par `categoryId`. Les aspects obligatoires refusés sont la cause numéro un
d'échec de publication.

## 5. Images

Une image minimum avant publication, URL en **HTTPS**. Pour uploader un binaire il faut
`UploadSiteHostedPictures` de la Trading API, qui retourne l'URL EPS à mettre dans
`product.imageUrls`.

Décision figée : **EPS, pas d'auto-hébergement.** L'upload est une image à la fois,
c'est le vrai goulot. Parallélise 4-6 workers. Rends-le idempotent en écrivant l'URL
retournée dans `inventory.hero_image_url` **avant** tout autre effet de bord.

## 6. Volumétrie

Endpoints bulk : 25 items par appel, pour les trois étapes. Limite par défaut 5 000
appels/jour au niveau application, largement suffisante. Ne construis pas de
throttling élaboré, construis le batching à 25.

## 7. OAuth

Refresh proactif, jamais à l'expiration. Alerte à J-30 avant expiration du refresh
token. Tokens chiffrés au repos, jamais loggés, jamais dans un message d'erreur.

## Interdits

- Appeler `bulkCreateOrReplaceInventoryItem` sans GET préalable
- Hardcoder un ID de catégorie ou un aspect
- Publier sans passer par `canPublish`
- Développer le flux de publication ailleurs que dans le sandbox eBay
- Ouvrir les vannes sans avoir publié et vérifié visuellement 10 cartes réelles
