# AR Studio

Art shop and laptop fund site, deployed on Vercel from `main`. No build step and no npm packages.

- `index.html`: the public site. When the backend is set up, it shows real pieces, the real goal and
  the real total, and takes payments through Paystack. Without the backend (or in a preview), it shows demo pieces.
- `admin.html`: your private page at **/admin**. Log in to upload pieces, hide or edit them, set the goal
  and see sales and donations.
- `api/`: the server code (Vercel functions). `lib/` holds shared helpers.
- `supabase/schema.sql`: the database. Paste it into Supabase once.
- `test/`: a local copy of everything with pretend Supabase and Paystack (`npm test`, or `node test/dev-server.js`).
- `sketch-studio-engine.js`: the Sketch Studio engine (drawing cleanup and mockups), for reuse.

## How it works

1. You upload a piece at /admin. The page cleans it with Sketch Studio, then sends a small **preview**
   (public, shown in the gallery) and the full **original** (private) to Supabase Storage.
2. A buyer picks a piece, enters their email and goes to Paystack's secure page to pay.
3. Paystack sends them back. The server checks the payment with Paystack, then gives them a
   30-minute link to the original, which they style and download. A link works for up to 10 downloads.
4. Paystack also tells the server directly (the webhook), so a payment still counts if the buyer closes the tab.

Prices always come from the database, so nobody can change what they pay from their browser.

## One-time setup (about 20 minutes, works from a phone)

### 1. Supabase (database, file storage, your login)
1. Go to [supabase.com](https://supabase.com), sign up and create a **New project**. Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste everything in `supabase/schema.sql` and tap **Run**.
3. Open **Authentication → Users → Add user → Create new user**. Use your email and a strong password,
   and tick **Auto confirm user**. This is your admin login.
4. Open **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up".
5. Open **Project Settings → API Keys → Legacy API keys**. You'll need the `anon` key and the `service_role` key.
   Your Project URL is under **Project Settings → Data API** (looks like `https://abcd.supabase.co`).

### 2. Paystack (payments)
1. Sign up at [paystack.com](https://paystack.com). You start in **Test mode**, which uses fake money.
2. Open **Settings → API Keys & Webhooks**. Copy the **Test Secret Key** (`sk_test_…`).
3. In the same page, set **Test Webhook URL** to `https://YOUR-SITE.vercel.app/api/paystack-webhook`.
4. To take real money later, finish Paystack's business activation, then use the **Live** secret key
   and set the **Live Webhook URL** the same way.

### 3. Vercel (connect it all)
1. Open your project → **Settings → Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_ANON_KEY` | the `anon` key |
   | `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key (secret) |
   | `PAYSTACK_SECRET_KEY` | `sk_test_…` (later `sk_live_…`) |
   | `ADMIN_EMAIL` | the email you used in Supabase step 3 |
   | `SITE_URL` | `https://YOUR-SITE.vercel.app` |

2. Open **Deployments**, tap the ⋯ on the latest one and choose **Redeploy** so it picks up the settings.
3. Optional: open the **Analytics** tab and tap **Enable** to see visitors.

Never put the `service_role` or Paystack secret key in any page or share them. If one leaks, make a new one
in Supabase or Paystack and update it in Vercel.

### 4. Try it
1. Go to `https://YOUR-SITE.vercel.app/admin`, log in and upload a piece.
2. Open the site, buy it, and on Paystack's test page pay with a
   [Paystack test card](https://paystack.com/docs/payments/test-payments/).
3. You should come back to the studio and be able to download it. The sale shows up in /admin.

## Changing things
- **Goal**: tap **Edit** on the Goal tile in /admin.
- **Pieces**: add, hide, edit or delete them in /admin.
- **Text, plans, slideshow, social links**: in `index.html`, the block marked `Edit these` near the top of the script.
