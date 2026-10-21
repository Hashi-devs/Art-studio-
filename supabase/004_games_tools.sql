-- Update 4: Games and Tools sections, a preview link per piece, and messages from people interested in them.
-- Paste into Supabase: SQL Editor → New query → Run. Safe to run more than once.
alter table public.pieces drop constraint if exists pieces_cat_check;
alter table public.pieces add constraint pieces_cat_check check (cat in ('arts','illustrations','stories','photos','games','tools'));
alter table public.pieces add column if not exists link text;

create table if not exists public.enquiries (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid references public.pieces(id) on delete set null,
  piece_name text,
  name text not null,
  email text not null,
  message text not null,
  budget text,
  status text not null default 'new' check (status in ('new','replied','closed')),
  created_at timestamptz not null default now()
);
create index if not exists enquiries_created_idx on public.enquiries (created_at desc);
alter table public.enquiries enable row level security;
