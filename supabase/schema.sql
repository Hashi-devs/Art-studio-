-- AR Studio database. Paste this whole file into Supabase: SQL Editor → New query → Run.
-- Safe to run again: it only creates what's missing.

create extension if not exists pgcrypto;

-- Pieces for sale
create table if not exists public.pieces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  cat text not null default 'arts' check (cat in ('arts','illustrations','stories','photos')),
  tag text not null default 'random' check (tag in ('people','things','anime','random')),
  kind text not null default 'drawing' check (kind in ('drawing','photo')),
  price integer not null default 1000 check (price > 0),          -- naira
  preview_path text not null,                                     -- in the public "previews" bucket
  original_path text not null,                                    -- in the private "originals" bucket
  published boolean not null default true,
  created_at timestamptz not null default now()
);

-- Purchases and donations
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,                                 -- Paystack reference
  type text not null check (type in ('piece','donation')),
  piece_id uuid references public.pieces(id) on delete set null,
  piece_name text,
  email text not null,
  note text,
  amount integer not null check (amount > 0),                     -- naira
  status text not null default 'pending' check (status in ('pending','paid','failed')),
  downloads integer not null default 0,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists orders_status_idx on public.orders (status);

-- One-row settings (the laptop goal)
create table if not exists public.settings (
  id integer primary key default 1 check (id = 1),
  goal integer not null default 500000,                           -- naira
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Lock everything down: the site only reaches these tables through its own server code,
-- which uses the service role key. Browsers can't read or write them directly.
alter table public.pieces enable row level security;
alter table public.orders enable row level security;
alter table public.settings enable row level security;

-- Image storage: previews are public (shown in the gallery), originals are private
-- (only handed out as short-lived links after payment).
insert into storage.buckets (id, name, public) values ('previews', 'previews', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('originals', 'originals', false) on conflict (id) do nothing;
alter table public.pieces add column if not exists description text;
alter table public.orders add column if not exists buyer_name text;
alter table public.orders add column if not exists extra integer not null default 0;
alter table public.orders add column if not exists on_wall boolean not null default true;
alter table public.orders add column if not exists wall_ok boolean not null default true;   -- the buyer's own choice
alter table public.pieces drop constraint if exists pieces_tag_check;
