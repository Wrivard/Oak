-- 003 — scans, sessions et empreintes
-- Voir docs/01-architecture-and-data-model.md, migration 003.

create type scan_status as enum
  ('pending','fingerprinted','matched','needs_review','resolved','rejected');

-- 'llm' est conservé volontairement : le niveau 3 est la review manuelle
-- (décision, docs/02 §5) mais la valeur ne coûte rien et garde la porte ouverte.
create type match_source as enum ('own_history','catalog','llm','manual');

create table sessions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  lane              text not null default 'adf',       -- adf | manual
  default_variant   card_variant   not null,           -- voir §foil dans docs/02
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
  candidates     jsonb,                         -- top 5 {sku, card_id, score}
  -- on delete restrict : un scan résolu ancre une ligne d'inventaire.
  resolved_sku   text references inventory(sku) on delete restrict,

  variant_conflict boolean not null default false,
  llm_raw        jsonb,
  error          text,

  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,

  unique (session_id, seq)
);

create index scans_queue  on scans (status, created_at);
create index scans_review on scans (created_at)
  where status = 'needs_review';
create index scans_phash  on scans (phash_front);

-- ---------------------------------------------------------------
-- Bibliothèque d'empreintes confirmées. C'est l'actif qui rend le système
-- gratuit, et le seul qui ne se reconstitue qu'en rescannant physiquement des
-- milliers de cartes.
--
-- Une empreinte est une IDENTITÉ DE CARTE, pas une ligne de stock : aucune
-- référence à inventory, sinon une opération d'inventaire pourrait la détruire.
-- Elle porte les composantes ; le worker dérive le SKU avec buildSku().
-- ---------------------------------------------------------------
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
