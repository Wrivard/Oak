---
name: queue-handler
description: Use when creating or modifying any job handler, worker loop, or background task in worker/. Covers the SKIP LOCKED claim pattern, deterministic idempotency keys, error classification, exponential backoff, circuit breakers, and required log fields. Apply this before writing any code that produces an external side effect.
---

# Job handlers — invariants

Détail : `docs/01-architecture-and-data-model.md` §migration 005 et
`docs/05-production.md` §2.

## 1. Réclamation

Un seul pattern autorisé. Jamais `SELECT` puis `UPDATE` séparés — ça double les jobs
dès que deux workers tournent.

```sql
update jobs set status='running', locked_at=now(), locked_by=$w, attempts=attempts+1
 where id = (
   select id from jobs
    where type=$1 and status in ('queued','failed') and run_after <= now()
    order by priority, id
    for update skip locked limit 1
 ) returning *;
```

## 2. Idempotence — la règle qui compte le plus

Tout job qui produit un effet de bord externe porte une `idempotency_key`
**déterministe**. Avant l'effet de bord, vérifie si la clé existe déjà en `done` ;
si oui, sors sans rien faire.

```ts
// ✅ rejouable
`ebay_publish:${sku}:${offerVersion}`
`ebay_sale:${orderId}:${lineItemId}`
`eps_upload:${sha256(imageBuffer)}`

// ❌ un retry crée un doublon
`ebay_publish:${Date.now()}`
`ebay_publish:${randomUUID()}`
```

Si tu ne peux pas construire une clé déterministe pour un effet de bord, c'est que le
design est faux. Arrête-toi et remonte-le.

## 3. Classification d'erreur

Toute erreur tombe dans une seule catégorie. Écris-la via `classifyError(err)`.

| Catégorie | Exemples | Comportement |
|---|---|---|
| Transitoire | 429, 503, timeout | retry, backoff `2^attempts * 10s` |
| Permanente | 400 validation, aspect manquant, SKU inexistant | `dead` immédiat |
| Ambiguë | 500, réponse malformée | 2 retries max puis `dead` |

Retryer une permanente 5 fois brûle du quota et retarde les vrais jobs. Un job `dead`
n'est **jamais** rejoué automatiquement.

## 4. Circuit breaker

Par service externe. 10 échecs consécutifs → circuit ouvert 5 minutes, jobs repoussés.
Sans ça, une panne eBay de 20 minutes épuise `max_attempts` sur des milliers de jobs.

Arrêt d'urgence : 20 échecs consécutifs sur un type = problème systémique. Arrête le
worker et alerte, ne continue pas.

## 5. Quantités

Jamais de read-modify-write sur `qty_on_hand`. Toujours `apply_qty_delta(sku, delta,
reason)`. La contrainte `check (qty_on_hand >= 0)` fait le travail de concurrence au
niveau base.

## 6. Logs

Chaque ligne est du JSON structuré et porte `scan_id`, `session_id`, et `sku` dès qu'il
est connu. Sans ça, reconstituer le parcours d'une carte est impossible.

```ts
log.info({ evt:'ebay.published', scan_id, sku, offer_id, duration_ms }, 'published');
```

## 7. Arrêt propre

SIGTERM → finit les jobs en cours, n'en prend plus de nouveaux, sort. Un `kill -9` en
plein `publishOffer` sans idempotence te laisse un état ambigu.

## Interdits

- `catch {}` vide
- Un effet de bord externe sans clé d'idempotence déterministe
- `SELECT` puis `UPDATE` pour réclamer un job
- Retry sur un upload TCGplayer (le delta s'appliquerait deux fois)
- Un appel API externe depuis une route Next.js — tout passe par la queue
