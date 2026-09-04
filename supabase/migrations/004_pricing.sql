-- 004 — prix
-- Voir docs/01-architecture-and-data-model.md, migration 004, et docs/03-pricing.md.

-- État COURANT des prix externes, un enregistrement par (sku, source).
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
-- Sémantique de chaque champ : docs/03-pricing.md §3.
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
