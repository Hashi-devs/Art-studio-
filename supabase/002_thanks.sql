-- Update 2: piece descriptions, buyer names, extra amounts and the Thank-yous wall.
-- Paste into Supabase: SQL Editor → New query → Run. Safe to run more than once.
alter table public.pieces add column if not exists description text;
alter table public.orders add column if not exists buyer_name text;
alter table public.orders add column if not exists extra integer not null default 0;
alter table public.orders add column if not exists on_wall boolean not null default true;
alter table public.orders add column if not exists wall_ok boolean not null default true;   -- the buyer's own choice
