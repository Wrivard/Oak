# 01 — Architecture et modèle de données

## Flux global

```
fi-7160 ──► dossier watché ──► ingest worker
                                     │
                          ┌──────────▼──────────┐
                          │  jobs (Postgres)    │
                          │  SKIP LOCKED queue  │
                          └──────────┬──────────┘
                                     │
        ┌────────────┬───────────────┼────────────┬─────────────┐
        ▼            ▼               ▼            ▼             ▼
   fingerprint   match          price_refresh  ebay_publish  tcg_export
   (pHash+CLIP)  (3 niveaux)    (cron)         (bulk 25)     (CSV/Playwright)
        │            │
        └────────────┴──► inventory (SKU, qty) ──► channel allocation
                                 │
                          review queue (exceptions seulement)
```

## Les deux processus

**`web`** — Next.js. Sert l'UI de review, écrit dans `jobs`, ne fait jamais d'appel
externe. Une requête HTTP ne doit jamais dépasser 200 ms.

**`worker`** — process Node long. Boucle sur `jobs`, un handler par `type`. Concurrence
configurable par type (`fingerprint` peut tourner à 8, `ebay_publish` à 1).

---

## Migration 001 — extensions et catalogue

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- Catalogue Pokémon. Source: pokemontcg.io (bulk JSON) + TCGdex (ja).
-- Read-only après seed. Refresh mensuel par upsert.
-- ---------------------------------------------------------------
create table cards (
  id                text primary key,          -- "base1-4"
  name              text not null,
  set_id            text not null,
  set_name          text not null,
  set_series        text,
  set_release       date,
  number            text not null,             -- "4" (numérateur seul)
  printed_total     int,                       -- 102 (dénominateur) — clé du matching
  total             int,                       -- inclut les secret rares
  rarity            text,
  supertype         text,
  subtypes          text[],
  artist            text,
  language          text not null default 'en',
  image_small       text,
  image_large       text,
  tcgplayer_url     text,
  cardmarket_id     text,
  name_normalized   text generated always as (lower(unaccent(name))) stored,
  updated_at        timestamptz not null default now()
);

create index cards_name_trgm    on cards using gin (name_normalized gin_trgm_ops);
create index cards_lookup       on cards (printed_total, number, language);
create index cards_lookup_total on cards (total, number, language);
create index cards_set          on cards (set_id, number);

-- Embedding CLIP de l'image officielle. Rempli par un job de seed.
create table card_embeddings (
  card_id    text primary key references cards(id) on delete cascade,
  embedding  vector(512) not null,
  model      text not null,                    -- "clip-vit-base-patch32"
  created_at timestamptz not null default now()
);
create index card_embeddings_hnsw on card_embeddings
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 200);
```

> `ef_construction` doit valoir au moins `2 × m`. 200 est un bon point de départ prod ;
> la valeur par défaut de pgvector est 64. Mesure la précision avec
> `ef_search = ef_construction` : sous 0,9, il y a de la marge d'amélioration.

## Migration 002 — inventaire

```sql
create type card_condition as enum ('NM','LP','MP','HP','DMG');
create type card_variant   as enum (
  'normal','holofoil','reverseHolofoil',
  '1stEditionNormal','1stEditionHolofoil','unlimitedHolofoil','promo'
);

create table inventory (
  sku              text primary key,           -- {card_id}-{variant}-{condition}-{lang}
  card_id          text not null references cards(id),
  variant          card_variant  not null,
  condition        card_condition not null,
  language         text not null default 'en',

  qty_on_hand      int not null default 0 check (qty_on_hand >= 0),
  qty_reserved_tcg int not null default 0 check (qty_reserved_tcg >= 0),

  hero_image_url   text,                       -- URL HTTPS finale (EPS eBay)
  hero_scan_id     uuid,

  -- état eBay
  ebay_offer_id    text,
  ebay_listing_id  text,
  ebay_qty_pushed  int  not null default 0,
  ebay_price_pushed numeric(10,2),

  -- état TCGplayer
  tcg_sku_id       text,                       -- unique par produit+condition+printing
  tcg_qty_pushed   int  not null default 0,
  tcg_price_pushed numeric(10,2),
  tcg_dirty        boolean not null default false,

  -- pricing
  value_estimate   numeric(10,2),
  current_price    numeric(10,2),
  price_breakdown  jsonb,
  last_priced_at   timestamptz,

  storage_location text,                       -- bac / boîte physique
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint qty_alloc_sane check (qty_reserved_tcg <= qty_on_hand)
);

create index inventory_card       on inventory (card_id);
create index inventory_reprice    on inventory (last_priced_at)
  where qty_on_hand > 0;
create index inventory_tcg_dirty  on inventory (tcg_dirty) where tcg_dirty;
create index inventory_unlisted   on inventory (created_at)
  where ebay_listing_id is null and qty_on_hand > 0;
```

**Pourquoi `condition` fait partie du SKU.** TCGplayer assigne un ID unique par
combinaison produit + set + condition + printing. Si tu regroupes NM et LP sous un SKU,
tu ne peux plus mapper vers TCGplayer, et tu dois grader la pile au pire pour eBay.

## Migration 003 — scans et sessions

```sql
create type scan_status as enum
  ('pending','fingerprinted','matched','needs_review','resolved','rejected');
create type match_source as enum ('own_history','catalog','llm','manual');

create table sessions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  lane              text not null default 'adf',       -- adf | manual
  default_variant   card_variant   not null,           -- voir §foil dans doc 02
  default_condition card_condition not null default 'NM',
  default_language  text not null default 'en',
  scanner_profile   text,                              -- réglages PaperStream utilisés
  expected_count    int,                               -- compteur de feuilles du scanner
  scanned_count     int not null default 0,
  status            text not null default 'open',
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz
);

create table scans (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references sessions(id),
  seq            int  not null,                 -- ordre de passage dans l'ADF

  front_path     text not null,
  back_path      text,

  phash_front    bit(64),
  dhash_front    bit(64),
  phash_back     bit(64),
  embedding      vector(512),

  status         scan_status not null default 'pending',
  match_source   match_source,
  confidence     numeric(4,3),
  candidates     jsonb,                          -- top 5 {sku, card_id, score}
  resolved_sku   text references inventory(sku) on delete restrict,

  variant_conflict boolean not null default false,
  llm_raw        jsonb,
  error          text,

  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,

  unique (session_id, seq)
);

create index scans_queue   on scans (status, created_at);
create index scans_review  on scans (created_at)
  where status = 'needs_review';
create index scans_phash   on scans (phash_front);

-- Bibliothèque d'empreintes confirmées. C'est l'actif qui rend le système gratuit.
-- Une empreinte est une IDENTITÉ DE CARTE, pas une ligne de stock. Aucune référence
-- à inventory : le stock va et vient, l'identité reste. Voir la note ci-dessous.
create table known_fingerprints (
  id           bigserial primary key,
  card_id      text not null references cards(id),
  variant      card_variant   not null,
  condition    card_condition not null,
  language     text not null default 'en',
  phash        bit(64) not null,
  dhash        bit(64) not null,
  embedding    vector(512) not null,
  source_scan  uuid,                            -- pas de FK, purement informatif
  confirmed_by match_source not null,
  created_at   timestamptz not null default now()
);
create index known_fp_card  on known_fingerprints (card_id);
create index known_fp_phash on known_fingerprints (phash);
create index known_fp_hnsw  on known_fingerprints
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 200);
```

**Pourquoi l'empreinte ne référence pas `inventory`.** Une bibliothèque d'empreintes
est l'actif le plus irremplaçable du système : elle se reconstitue seulement en
rescannant physiquement des milliers de cartes. La coupler au stock la rendait
destructible par une opération d'inventaire. Elle porte donc les composantes
(`card_id`, `variant`, `condition`, `language`), pas le SKU.

**Conséquence sur le niveau 1 de résolution.** Un match retourne les composantes.
Le worker dérive le SKU avec `buildSku()`, upsert la ligne `inventory` si elle
n'existe pas, puis appelle `apply_qty_delta`. Ça règle proprement le cas « carte
connue, stock à zéro ».

## Migration 004 — prix

```sql
-- État courant des prix externes, un enregistrement par (sku, source).
-- Écrasé à chaque refresh — ce n'est pas un historique. L'historique de NOS prix
-- de vente est dans price_history.
create table price_current (
  sku         text not null references inventory(sku) on delete cascade,
  source      text not null,                    -- tcgplayer | ebay_sold | cardmarket
  low         numeric(10,2),
  mid         numeric(10,2),
  high        numeric(10,2),
  market      numeric(10,2),
  n_sales     int,
  window_days int,
  raw         jsonb,
  fetched_at  timestamptz not null default now(),
  primary key (sku, source)
);

create table price_history (
  id         bigserial primary key,
  sku        text not null,
  price      numeric(10,2) not null,
  reason     text not null,                     -- initial | reprice | manual
  breakdown  jsonb,
  created_at timestamptz not null default now()
);
create index price_history_sku on price_history (sku, created_at desc);

create table pricing_rules (
  id         int primary key default 1 check (id = 1),
  config     jsonb not null,
  updated_at timestamptz not null default now()
);

-- Seed dans la migration elle-même. Le système ne doit jamais démarrer sans règles
-- de prix : un pricing_rules vide est un bug silencieux qui produit des prix nuls.
insert into pricing_rules (id, config) values (1, '{
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
}'::jsonb)
on conflict (id) do nothing;
```

Voir `docs/03-pricing.md` §3 pour la sémantique de chaque champ.

## Migration 005 — jobs et événements

```sql
create table jobs (
  id            bigserial primary key,
  type          text not null,
  payload       jsonb not null default '{}',
  idempotency_key text unique,                  -- protège les effets de bord externes
  status        text not null default 'queued', -- queued|running|done|failed|dead
  priority      int  not null default 100,      -- plus bas = plus prioritaire
  attempts      int  not null default 0,
  max_attempts  int  not null default 5,
  run_after     timestamptz not null default now(),
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index jobs_claim on jobs (type, status, run_after, priority)
  where status in ('queued','failed');
create index jobs_dead  on jobs (created_at) where status = 'dead';

create table channel_events (
  id         bigserial primary key,
  channel    text not null,                     -- ebay | tcgplayer
  sku        text,
  event      text not null,                     -- sold|price_push|qty_push|error|reconcile
  qty_delta  int,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index channel_events_sku on channel_events (sku, created_at desc);
create index channel_events_recent on channel_events (created_at desc);
```

### La queue, en une requête

```sql
-- Réclamation atomique. C'est le seul pattern autorisé pour prendre un job.
update jobs
   set status = 'running',
       locked_at = now(),
       locked_by = $worker_id,
       attempts = attempts + 1
 where id = (
   select id from jobs
    where type = $1
      and status in ('queued','failed')
      and run_after <= now()
    order by priority, id
    for update skip locked
    limit 1
 )
returning *;
```

`FOR UPDATE SKIP LOCKED` permet à plusieurs workers de tirer en parallèle sans se
bloquer. N'utilise jamais `SELECT` puis `UPDATE` séparés — tu vas doubler des jobs.

**Backoff** : à l'échec, `status='failed'`, `run_after = now() + (2 ^ attempts) * interval '10 seconds'`.
Au-delà de `max_attempts`, `status='dead'` et une alerte. Les jobs morts ne sont jamais
rejoués automatiquement.

## Migration 006 — mouvements de quantité

Ne fais **jamais** `qty_on_hand = $new`. Toujours un delta atomique :

```sql
create or replace function apply_qty_delta(
  p_sku text, p_delta int, p_reason text
) returns int language plpgsql as $$
declare
  new_qty      int;
  new_reserved int;
begin
  update inventory
     set qty_on_hand      = qty_on_hand + p_delta,
         -- Clamp de la réservation TCG dans le MÊME update. Les deux colonnes
         -- bougent atomiquement, la contrainte qty_alloc_sane ne peut pas être
         -- violée par une vente eBay légitime. Voir la note ci-dessous.
         qty_reserved_tcg = least(qty_reserved_tcg, greatest(qty_on_hand + p_delta, 0)),
         updated_at       = now(),
         -- Une vente TCG vient de TCGplayer : le repousser serait un aller-retour
         -- inutile. Tout autre mouvement rend la ligne sale.
         tcg_dirty        = case when p_reason = 'tcg_sale' then tcg_dirty else true end
   where sku = p_sku
  returning qty_on_hand, qty_reserved_tcg into new_qty, new_reserved;

  if not found then
    raise exception 'sku % introuvable', p_sku;
  end if;

  insert into channel_events (channel, sku, event, qty_delta, payload)
  values ('internal', p_sku, p_reason, p_delta,
          jsonb_build_object('new_qty', new_qty, 'new_reserved_tcg', new_reserved));

  return new_qty;
end $$;
```

La contrainte `check (qty_on_hand >= 0)` fait le reste : une vente concurrente qui
ferait passer sous zéro échoue au niveau base, pas au niveau applicatif.

**Pourquoi le clamp.** `qty_alloc_sane` (`qty_reserved_tcg <= qty_on_hand`) est correcte
comme invariant mais fausse comme garde : qty 7, on réserve 2 pour TCGplayer, 5 ventes
eBay passent — on est à qty 2 / reserved 2, et la 6e vente eBay légitime viole la
contrainte et échoue. Un vrai encaissement de vente ne doit jamais être refusé par la
base. Le clamp abaisse la réservation en même temps que le stock ; le job d'export
TCGplayer voit la nouvelle réservation au prochain passage et repousse la quantité.
Une réservation est une intention, pas une promesse.
