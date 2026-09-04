-- 002 — inventaire
-- Voir docs/01-architecture-and-data-model.md, migration 002.

create type card_condition as enum ('NM','LP','MP','HP','DMG');
create type card_variant   as enum (
  'normal','holofoil','reverseHolofoil',
  '1stEditionNormal','1stEditionHolofoil','unlimitedHolofoil','promo'
);

-- Invariant 7 de CLAUDE.md : une ligne inventory ne se supprime JAMAIS.
-- Une quantité qui tombe à zéro reste à zéro.
create table inventory (
  sku              text primary key,           -- buildSku() — lib/sku.ts, seul constructeur
  card_id          text not null references cards(id),
  variant          card_variant  not null,
  condition        card_condition not null,
  language         text not null default 'en',

  qty_on_hand      int not null default 0 check (qty_on_hand >= 0),
  qty_reserved_tcg int not null default 0 check (qty_reserved_tcg >= 0),

  hero_image_url   text,                       -- URL HTTPS finale (EPS eBay)
  hero_scan_id     uuid,

  -- état eBay
  ebay_offer_id     text,
  ebay_listing_id   text,
  ebay_qty_pushed   int  not null default 0,
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

  -- Invariant, pas garde : c'est apply_qty_delta (migration 006) qui le maintient
  -- vrai en clampant la réservation dans le même UPDATE que le stock.
  constraint qty_alloc_sane check (qty_reserved_tcg <= qty_on_hand)
);

create index inventory_card      on inventory (card_id);
create index inventory_reprice   on inventory (last_priced_at)
  where qty_on_hand > 0;
create index inventory_tcg_dirty on inventory (tcg_dirty) where tcg_dirty;
create index inventory_unlisted  on inventory (created_at)
  where ebay_listing_id is null and qty_on_hand > 0;
