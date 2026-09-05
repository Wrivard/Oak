# 05 — Production

Ce doc est ce qui sépare un prototype d'un système que tu laisses tourner la nuit.

---

## 1. Observabilité

À 1 700 cartes/jour, tu ne peux pas debugger en lisant des logs. Il te faut trois choses.

### 1.1 Logs structurés

JSON uniquement, jamais de `console.log` de string. Chaque ligne porte un contexte
corrélable.

```ts
log.info({
  evt: 'scan.resolved',
  scan_id, session_id, sku,
  match_source, confidence,
  duration_ms,
}, 'scan resolved');
```

Champs obligatoires sur toute ligne touchant une carte : `scan_id`, `session_id`, et
`sku` dès qu'il est connu. Sans ça tu ne peux pas reconstituer le parcours d'une carte.

### 1.2 Le dashboard qui compte

Une seule page, cinq métriques. Si elle est verte, tu peux aller dormir.

| Métrique | Seuil d'alarme |
|---|---|
| Taux de résolution par niveau (own_history / catalog / manual) | `manual > 15 %` |
| Profondeur de queue par type de job | `> 5 000` ou croissance monotone 1 h |
| Jobs `dead` dernières 24 h | `> 0` |
| Écart de réconciliation eBay | `> 0` |
| Cartes en `needs_review` | `> capacité quotidienne` |

Le **taux de review manuelle** est ta métrique économique principale : c'est le seul
poste de coût marginal par carte qui reste, et il se paie en minutes de ton temps.
S'il remonte, quelque chose a changé : nouveaux sets non seedés, réglages scanner
modifiés, OCR qui décroche sur une ère, seuils dérivés. Il devrait descendre avec le
temps, jamais monter.

### 1.3 Traces sur les appels externes

Chaque appel eBay et tcgapi : durée, statut, taille de payload, et pour eBay
les headers de rate limit. Stocke-les dans `channel_events`. Quand eBay renvoie une
erreur cryptique dans six mois, tu veux le payload exact qui l'a causée.

---

## 2. Gestion d'erreurs

### 2.1 Classification

Trois catégories, trois comportements. Toute erreur doit tomber dans une seule.

| Catégorie | Exemples | Comportement |
|---|---|---|
| **Transitoire** | 429, 503, timeout réseau | retry avec backoff exponentiel |
| **Permanente** | 400 validation, aspect manquant, SKU inexistant | `dead` immédiat, pas de retry |
| **Ambiguë** | 500 d'eBay, réponse malformée | 2 retries max puis `dead` |

Retryer une erreur permanente 5 fois, c'est brûler du quota et retarder les vrais jobs.
Écris un `classifyError(err)` et teste-le.

### 2.2 La règle d'or de l'idempotence

Tout job qui produit un effet de bord externe (publier une annonce, uploader une image,
décrémenter un stock) doit porter une `idempotency_key` déterministe.

```ts
// ✅ déterministe: rejouable sans danger
idempotency_key = `ebay_publish:${sku}:${offerVersion}`
idempotency_key = `ebay_sale:${orderId}:${lineItemId}`

// ❌ un retry crée un doublon
idempotency_key = `ebay_publish:${Date.now()}`
```

Avant tout effet de bord, vérifie si la clé existe déjà en `done`. Si oui, sors sans rien
faire et retourne le résultat mémorisé.

### 2.3 Ce qu'on ne fait jamais

- `catch {}` vide
- Retry sur un upload TCGplayer (le delta s'appliquerait deux fois)
- Résolution automatique d'oversell
- Repricing automatique quand `method === 'no_data'`
- Continuer un batch après 20 échecs consécutifs — c'est un problème systémique, arrête
  le worker et alerte

### 2.4 Circuit breaker

Par service externe. Après 10 échecs consécutifs, ouvre le circuit pour 5 minutes et
repousse les jobs concernés. Sans ça, une panne eBay de 20 minutes te fait brûler
`max_attempts` sur des milliers de jobs et tu te retrouves avec une montagne de `dead`
à rejouer à la main.

---

## 3. Tests

### 3.1 Priorités

Ce qui doit avoir des tests unitaires avant d'aller en prod, dans l'ordre :

1. **`suggestPrice`** — tous les cas du tableau de bandes, plus : valeur `null`,
   valeur négative, condition inconnue, valeur exactement sur une frontière de bande
2. **`estimateValue`** — 0/1/2/3/10 comps, comps avec aberrations, toutes sources `null`
3. **`allocate`** — qty 0, 1, 2, 3, 10, 100
4. **Delta TCGplayer** — la séquence push → vente → push, en vérifiant que le second
   delta est correct et pas cumulatif
5. **Génération de titre** — 500 cartes réelles, aucun > 80 caractères
6. **`classifyError`**

### 3.2 Golden set du matching

Constitue un jeu de 500 scans réels étiquetés à la main. C'est ton harnais de
non-régression pour tout changement de seuil ou de modèle.

```
tests/fixtures/golden/
  ├── scans/          500 images
  └── labels.json     { scan_id: { sku, variant, condition } }
```

Le test échoue si la précision descend sous la ligne de base ou si le taux de review
manuelle monte de plus de 2 points. **Aucun changement de seuil ne se merge sans passer ce
test.** C'est la seule protection contre l'optimisation d'un seuil qui améliore un cas
et en casse cinquante.

### 3.3 Environnements externes

- eBay a un **sandbox**. Utilise-le pour tout le développement du flux de publication.
- Le sandbox ne reproduit pas fidèlement les aspects par catégorie. Prévois une phase
  de validation en production sur 10 cartes réelles avant d'ouvrir les vannes.

### 3.4 Test de charge minimal

Avant la première vraie journée : passe 2 000 scans synthétiques dans le pipeline et
mesure le débit bout en bout, la profondeur de queue, la mémoire du worker sur une heure.
Un leak dans le traitement d'image ne se voit pas sur 50 cartes.

---

### 3.5 Ce que le test de charge a réellement trouvé

Le test de charge n'est pas une formalité : la **première** exécution a révélé un bug
qui aurait perdu des scans en production. Voir `docs/02` §1 pour le détail — ingestion
non bornée, pool de connexions épuisé, 1 849 fichiers abandonnés en silence.

Retiens-en la méthode : ce bug était invisible en test unitaire et invisible sur trois
cartes. Il n'apparaît qu'en rafale. **Refais tourner `pnpm loadtest` après toute
modification du watcher, de la boucle worker ou du pool.**

---

## 4. Sécurité et secrets

- Aucun secret dans le repo. `.env.local` en dev, variables d'environnement en prod.
- Les tokens eBay (access + refresh) chiffrés au repos en base, jamais loggés, jamais
  dans un message d'erreur. Écris un redacteur de logs qui masque tout ce qui ressemble
  à un token.
- La `service_role` key Supabase ne touche jamais le navigateur. Les route handlers
  et les server actions Next l'utilisent côté serveur, au même titre que le worker.
  Acceptable en mono-utilisateur. **Ne pas ajouter de RLS** — c'est un non-objectif
  explicite (voir `CLAUDE.md`).
- Rotation planifiée du refresh token eBay avec alerte à J-30 avant expiration.
- `.gitignore` : `.env*`, `inbox/`, `processed/`, `*.csv`, `tests/fixtures/golden/scans/`
  (des milliers d'images n'ont rien à faire dans git — utilise git-lfs ou un bucket).

---

## 5. Sauvegardes et reprise

Ce qui est irremplaçable, par ordre de douleur si tu le perds :

1. **`known_fingerprints`** — c'est des mois de review manuelle. Backup quotidien,
   testé en restauration au moins une fois.
2. **`inventory`** — ton stock réel. Si tu le perds, tu rescannes tout physiquement.
3. `price_history`, `channel_events` — utile, pas vital.

Ce qui est reconstructible et ne mérite pas de backup : `cards`, `card_embeddings`
(reseedables), les images (chez eBay), `price_current` (refetchable).

**Teste ta restauration.** Un backup jamais restauré n'est pas un backup.

---

## 6. Runbooks

### 6.1 « La queue monte et ne redescend pas »

1. `select type, status, count(*) from jobs group by 1,2` — identifier le type bloqué
2. `select last_error, count(*) from jobs where status='failed' group by 1 order by 2 desc`
3. Si une seule erreur domine : c'est systémique, arrête le worker avant de brûler du quota
4. Si l'erreur est un 429 : vérifie le circuit breaker, il devrait déjà être ouvert

### 6.2 « Une session ne se ferme pas (écart de comptage) »

Écart entre `expected_count` et `scanned_count` = double-feed probable.

1. Ne ferme pas la session
2. Repasse physiquement la pile
3. Compare les `seq` présents dans `scans` pour trouver les trous
4. Si l'écart persiste, la pile est physiquement recomptée avant tout listing

Ne contourne jamais cette vérification. Une carte fantôme dans l'inventaire finit en
commande non honorable.

### 6.3 « Des prix aberrants sont partis en prod »

1. `select * from price_history where created_at > $t and reason='reprice'`
2. Identifier la source fautive via `breakdown`
3. Rollback : republier depuis `price_history` la valeur précédente pour les SKUs touchés
4. Ajouter un cas au test unitaire de `estimateValue` pour le pattern rencontré

C'est pour ça que `price_history` garde le `breakdown` complet. Sans lui, ce runbook est
impossible à exécuter.

### 6.4 « Le taux de review manuelle a doublé »

Causes par ordre de probabilité : un nouveau set est sorti et n'est pas dans `cards` ;
les réglages du scanner ont changé ; l'OCR du numéro échoue sur une ère donnée ;
les seuils ont été touchés sans passer le golden set.

1. `select date_trunc('day',created_at), match_source, count(*) from scans group by 1,2`
2. Vérifier la date du dernier seed catalogue
3. Comparer `sessions.scanner_profile` entre une session saine et une session dégradée

---

## 7. Ce que ce système ne fera jamais

Écris-le dans le repo pour que ni toi ni un agent ne dérive :

- Il ne devine jamais un prix quand il n'a pas de données
- Il n'annule jamais une commande automatiquement
- Il ne republie jamais une annonce sans clé d'idempotence
- Il n'écrase jamais une ligne d'inventaire eBay sans GET préalable
- Il ne retry jamais un upload TCGplayer
- Il ne ferme jamais une session dont le comptage ne balance pas
