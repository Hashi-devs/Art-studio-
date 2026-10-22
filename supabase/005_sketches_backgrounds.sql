-- Update 5: a Sketches section, coloured drawings, and download backgrounds & mockups you manage in /admin.
-- Safe to run more than once.

alter table public.pieces drop constraint if exists pieces_cat_check;
alter table public.pieces add constraint pieces_cat_check check (cat in ('arts','sketches','illustrations','stories','photos','games','tools'));
alter table public.pieces drop constraint if exists pieces_kind_check;
alter table public.pieces add constraint pieces_kind_check check (kind in ('drawing','colour','photo'));

-- Backgrounds buyers can put a drawing on before downloading.
-- type 'paper': the drawing is laid on the image. type 'mockup': it goes into the area (x, y, w, h as 0-1 of the image).
create table if not exists public.backgrounds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'paper' check (type in ('paper','mockup')),
  path text not null,                      -- in the public "previews" bucket, or /assets/... on the site
  area jsonb,                              -- mockups only: {"x":0.16,"y":0.11,"w":0.84,"h":0.79}
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.backgrounds enable row level security; -- only the server reads and writes it

-- The four you started with (their images are files on the site).
insert into public.backgrounds (name, type, path, area, sort)
select * from (values
  ('White', 'paper', '/assets/bg/white.jpg', null::jsonb, 1),
  ('Grey', 'paper', '/assets/bg/grey.jpg', null::jsonb, 2),
  ('Brown', 'paper', '/assets/bg/brown.jpg', null::jsonb, 3),
  ('Binder', 'mockup', '/assets/bg/binder.jpg', '{"x":0.162,"y":0.113,"w":0.838,"h":0.785}'::jsonb, 4)
) v(name, type, path, area, sort)
where not exists (select 1 from public.backgrounds);
