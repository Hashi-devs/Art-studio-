-- Update 3: let filter tags be anything you type (not just people / things / anime / random).
-- Paste into Supabase: SQL Editor → New query → Run. Safe to run more than once.
alter table public.pieces drop constraint if exists pieces_tag_check;
