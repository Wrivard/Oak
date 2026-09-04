# CLAUDE.md

Contexte projet. Lu à chaque session. Garde-le à jour.

## Ce qu'on construit

Pipeline privé de listing Pokémon en volume. Un seul utilisateur. Les cartes entrent
par un scanner ADF, ressortent en annonces eBay et en inventaire TCGplayer.

**Non-objectifs, à ne jamais construire :** auth multi-utilisateur, billing, système de
crédits, page marketing, onboarding, support de TCG autres que Pokémon, RLS Supabase.
Si une tâche semble en demander, arrête-toi et demande.

## Paramètres de l'opération

| | |
|---|---|
| Volume | 25-50k cartes scannées / mois (~1 700/jour) |
| SKUs uniques attendus | 12-15k (taux de duplication élevé sur le bulk) |
| Scanner | Fujitsu fi-7160, duplex, ADF 80 feuilles, ~60 ppm |
| Doubles | regroupés en qty N sur un SKU partagé |
| Gradées | minoritaires, lane manuelle séparée |
| Canaux | eBay (temps réel) + TCGplayer (batch quotidien) |
| Contrainte dure | coût marginal par carte doit tendre vers zéro |

## Stack

- **Next.js 15** App Router, TypeScript strict, React 19
- **Supabase** Postgres 15+ avec `pgvector`, `pg_trgm`, `unaccent`
- **Worker** process Node séparé, longue durée, draine `jobs` en Postgres
- **Aucun appel Claude API.** Le niveau 3 de résolution est la review manuelle.
  Voir `PROMPTS.md` étape 8.
- **sharp** pour tout le traitement d'image
- **Playwright** pour l'automation TCGplayer
- **Vitest** pour les tests, **Playwright Test** pour l'e2e

Pas de Redis, pas de Kafka, pas de microservices. Un Postgres et deux process.

## Invariants non négociables

1. **Le SKU est la clé de tout.** Format `{card_id}-{variant}-{condition}-{lang}`.
   Une carte physique n'est jamais une ligne d'annonce, elle incrémente un SKU.
2. **Aucune écriture d'inventaire hors transaction.** Les quantités bougent par
   `UPDATE ... RETURNING` avec contrainte `CHECK (qty >= 0)`, jamais par read-modify-write.
3. **Tout job est idempotent.** Rejouer un job ne doit jamais doubler une quantité ni
   republier une annonce. Clé d'idempotence sur chaque effet de bord externe.
4. **Aucun appel API externe dans une requête HTTP.** Tout passe par la queue.
5. **Les prix ne sont jamais lus en direct** pendant un scan ou une review. Toujours
   depuis `price_current`, rafraîchi par cron.
6. **Aucun secret dans le repo.** `.env.local` en dev, variables d'env en prod.
7. **Une ligne `inventory` ne se supprime jamais.** Une quantité qui tombe à zéro reste
   à zéro. Les empreintes et l'historique y font référence.
8. **Un seul constructeur de SKU.** `buildSku({ card_id, variant, condition, language })`
   dans `lib/sku.ts`. Aucune concaténation de SKU ailleurs dans le codebase.

## Conventions de code

- TypeScript `strict: true`, pas de `any`, pas de `!` non-null assertion
- Erreurs : jamais de `catch {}` vide. Toute erreur avalée doit être loggée avec
  contexte structuré et un `scan_id` ou `sku`.
- Toute fonction qui touche l'argent (pricing, quantités, frais) doit avoir des tests
  unitaires avec cas limites avant d'être appelée en prod.
- Montants en `numeric` en base, en `number` de cents en TS. Jamais de float pour de
  l'argent dans un calcul cumulatif.
- Migrations SQL numérotées dans `supabase/migrations/`, jamais éditées après application.

## Ordre de lecture des docs

1. `docs/01-architecture-and-data-model.md` — schéma complet, à lire en premier
2. `docs/02-ingest-and-matching.md` — le cœur du système
3. `docs/03-pricing.md`
4. `docs/04-channels.md` — eBay + TCGplayer
5. `docs/05-production.md` — observabilité, tests, runbooks
6. `PROMPTS.md` — l'ordre de build

## Avant de coder quoi que ce soit

Les étapes 0 et 1 de `PROMPTS.md` sont des **expériences, pas du code**. Si elles n'ont
pas été faites, dis-le et arrête-toi. Le design du matching et du pricing en dépend.

## Quand tu bloques

Si une API externe se comporte autrement que ce que décrivent ces docs, **crois l'API,
pas les docs**, et mets à jour le doc concerné dans le même commit. Ces docs ont été
écrits à partir de recherche, pas d'exécution.

## Skills du projet

Quatre skills dans `.claude/skills/`, chargés automatiquement quand la tâche matche
leur description. Ils contiennent les garde-fous, pas la référence — le détail reste
dans `docs/`.

| Skill | Déclenche sur |
|---|---|
| `ebay-inventory-ops` | tout code eBay Sell API |
| `queue-handler` | tout handler de job ou effet de bord externe |
| `money-path` | prix, quantités, frais, CSV TCGplayer |
| `card-matching-thresholds` | seuils, modèles d'embedding, logique de résolution |

Si tu modifies un garde-fou dans un skill, mets à jour le doc correspondant dans le
même commit. Une seule source de vérité.
