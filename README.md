# AR Studio

Art shop and laptop fund site, hosted on **Cloudflare Workers** (free plan, commercial use allowed),
with **Supabase** for the database and image storage and **Paystack** for payments. No packages, no build step.

```
public/              everything visitors download
  index.html         the site (demo pieces if the server isn't set up)
  admin.html         your private page at /admin
  404.html, robots.txt, _headers, assets/, fonts/, sketch-studio-engine.js
src/                 the server code (never public)
  worker.js          sends /api/* to the handlers, everything else to /public
  api.js             every /api route
  lib/               Supabase, Paystack and order helpers
supabase/            database setup and updates (paste into Supabase's SQL Editor)
test/                a local copy of everything with pretend Supabase and Paystack
wrangler.jsonc       Cloudflare's settings for this project
```

## How it works

1. You upload a piece at **/admin**. Sketch Studio cleans it (and removes notebook lines), you tidy it with
   the eraser, and it uploads a small **preview** (public, for the gallery) and the full **original** (private).
2. A buyer opens a piece, sees its details, adds an optional extra, gives their name, email and a message,
   and pays on Paystack's secure page.
3. Paystack sends them back. The server checks the payment with Paystack, then gives them a 30-minute link
   to the original. They pick a background and download it (up to 10 downloads).
4. Paystack also tells the server directly (the webhook), so a payment still counts if the buyer closes the tab.
5. Buyers who agreed appear on the **Thank-yous** wall with their message. Emails and amounts never show.

Prices always come from the database, so nobody can change what they pay from their browser.

## Setting up Cloudflare (one time)

1. Make a free account at **dash.cloudflare.com/sign-up** and verify your email. Skip adding a domain.
2. Open **Compute (Workers)** (or **Workers & Pages**) → **Create** → **Import a repository**.
3. Connect **GitHub**, allow access to **Art-studio-**, and pick it.
4. Project name `ar-studio`. Leave the build command empty. Deploy command: `npx wrangler deploy`. Tap **Deploy**.
5. When it finishes, open the project → **Settings** → **Variables and Secrets** and add these six
   (choose **Secret** for the two keys):

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | your Supabase Project URL |
   | `SUPABASE_ANON_KEY` | the publishable key (`sb_publishable_…`, or legacy `anon`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | the secret key (`sb_secret_…`, or legacy `service_role`) — **Secret** |
   | `PAYSTACK_SECRET_KEY` | `sk_test_…` (later `sk_live_…`) — **Secret** |
   | `ADMIN_EMAIL` | the email of your Supabase admin user |
   | `SITE_URL` | your site address, e.g. `https://ar-studio.yourname.workers.dev` (no `/` at the end) |

6. In Paystack → **Settings → API Keys & Webhooks**, set the Webhook URL to `SITE_URL` + `/api/paystack-webhook`.
7. Every push to `main` on GitHub now updates the site automatically.

Never put the Supabase secret key or Paystack secret key in any page or share them. If one leaks, make a new one
in Supabase or Paystack and update it in Cloudflare.

## Supabase (one time)

1. Create a project, then in **SQL Editor → New query** paste `supabase/schema.sql` and **Run**.
2. **Authentication → Users → Add user**: your email + a strong password, **Auto confirm**.
3. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
4. Copy the Project URL and keys from **Project Settings → API Keys**.

Updates for an older database (each is safe to run twice): `supabase/002_thanks.sql`, `supabase/003_tags.sql`.

## Going live with real money

1. In Paystack, **Activate business** (Starter Business: BVN, ID, a bank account for payouts).
2. Clear your test orders once in Supabase's SQL Editor: `delete from public.orders;`
3. In Cloudflare, change `PAYSTACK_SECRET_KEY` to the live key. In Paystack, set the **Live** webhook URL.

## Trying it locally

`npm test` runs the server tests. `npm run dev` starts the whole site at http://localhost:3999 with
pretend Supabase and Paystack (admin login `admin@test.dev` / `testpass`).

## Changing things
- **Goal, pieces, tags, descriptions, the Thank-yous wall**: all in /admin.
- **Text, plans, slideshow, social links**: `public/index.html`, the block marked `Edit these` near the top of the script.
