-- 001 — extensions et catalogue
-- Voir docs/01-architecture-and-data-model.md, migration 001.

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- unaccent() est déclarée STABLE, pas IMMUTABLE : Postgres refuse de l'utiliser
-- dans une colonne générée ("generation expression is not immutable"). C'est
-- vérifié, pas supposé — voir docs/01, note sur name_normalized.
--
-- Le wrapper la fixe. La promesse d'immutabilité est tenue tant que personne ne
-- redéfinit le dictionnaire unaccent ; si ça arrivait, il faudrait reconstruire
-- la colonne. C'est le compromis standard pour ce cas.
-- ---------------------------------------------------------------
create or replace function immutable_unaccent(text)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, extensions, pg_catalog
as $$ select unaccent($1) $$;

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
  name_normalized   text generated always as (lower(immutable_unaccent(name))) stored,
  updated_at        timestamptz not null default now()
);

create index cards_name_trgm    on cards using gin (name_normalized gin_trgm_ops);
create index cards_lookup       on cards (printed_total, number, language);
create index cards_lookup_total on cards (total, number, language);
create index cards_set          on cards (set_id, number);

-- Embedding CLIP de l'image officielle. Rempli par un job de seed (étape 3).
create table card_embeddings (
  card_id    text primary key references cards(id) on delete cascade,
  embedding  vector(512) not null,
  model      text not null,                    -- "clip-vit-base-patch32"
  created_at timestamptz not null default now()
);
create index card_embeddings_hnsw on card_embeddings
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 200);
