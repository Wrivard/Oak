-- 005 — jobs et événements
-- Voir docs/01-architecture-and-data-model.md, migration 005.

create table jobs (
  id              bigserial primary key,
  type            text not null,
  payload         jsonb not null default '{}',
  idempotency_key text unique,                  -- protège les effets de bord externes
  status          text not null default 'queued', -- queued|running|done|failed|dead
  priority        int  not null default 100,    -- plus bas = plus prioritaire
  attempts        int  not null default 0,
  max_attempts    int  not null default 5,
  run_after       timestamptz not null default now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index jobs_claim on jobs (type, status, run_after, priority)
  where status in ('queued','failed');
create index jobs_dead  on jobs (created_at) where status = 'dead';

create table channel_events (
  id         bigserial primary key,
  channel    text not null,                     -- ebay | tcgplayer | internal
  sku        text,
  event      text not null,                     -- sold|price_push|qty_push|error|reconcile
  qty_delta  int,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index channel_events_sku    on channel_events (sku, created_at desc);
create index channel_events_recent on channel_events (created_at desc);
