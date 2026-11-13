# BuckLine

**Pay a buck. Own the line.**

One line of text on the internet. Anyone can pay $1 to replace it. It stays up until the next person pays.

- Plain Node.js (20+). **No npm dependencies.**
- Stripe Checkout through Stripe's REST API, with webhook signature checks.
- Everyone watching sees the new line instantly (Server-Sent Events).
- The current line is saved to a JSON file (`/data/line.json` in the container).

## Run locally

```bash
cp .env.example .env     # optional
npm start                # http://localhost:3000
npm test
```

If `STRIPE_SECRET_KEY` is empty, the app runs in **demo mode**: the pay button changes the line for free.

## Run in a container

```bash
docker build -t buckline .
docker run -d --name buckline -p 3000:3000 -v buckline-data:/data --env-file .env buckline
```

Or use Compose:

```bash
cp .env.example .env
docker compose up -d --build
```

The image runs as a non-root user, has a `/healthz` health check and keeps its data in the `/data` volume.

## Taking real payments

1. In the Stripe Dashboard, copy your secret key into `STRIPE_SECRET_KEY`.
2. Set `BASE_URL` to your public URL (Stripe sends buyers back there).
3. Add a webhook endpoint at `https://YOUR_DOMAIN/api/stripe/webhook` for these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
4. Copy that endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.

To test locally with the Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# copy the whsec_... it prints into STRIPE_WEBHOOK_SECRET, then restart
```

### How a change happens

1. The browser sends `POST /api/checkout` with the text. The server checks it (length, invisible characters, blocked words) and creates a Checkout Session with the text in its metadata.
2. The buyer pays on Stripe's page.
3. Stripe calls the webhook. The server checks the signature, makes sure the session is `paid`, checks the text again and updates the line. Duplicate webhook deliveries are ignored.
4. Every open browser gets the new line over `/api/events`.

The line changes only when the webhook arrives, never on the redirect, so nobody can skip payment by opening the success URL.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:PORT` | Public URL for Stripe redirects |
| `STRIPE_SECRET_KEY` | — | Empty = demo mode |
| `STRIPE_WEBHOOK_SECRET` | — | Required to apply paid changes |
| `PRICE_CENTS` | `100` | Price per change |
| `CURRENCY` | `usd` | Checkout currency |
| `MAX_LENGTH` | `80` | Max characters |
| `ADMIN_USER` | `admin` | Admin panel login |
| `ADMIN_PASSWORD` | — | Admin panel password; empty = `/adminpanel` disabled |
| `TRANSACTIONS_FILE` | next to `DATA_FILE` | Transaction log (JSON Lines) |
| `INITIAL_TEXT` | `Hello, internet.` | Text before the first change |
| `BLOCKED_WORDS` | — | Comma-separated words to reject |
| `CHECKOUT_RATE_LIMIT` | `10` | Checkout attempts per IP per minute |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy so rate limits use `X-Forwarded-For` |
| `DATA_FILE` | `./data/line.json` (`/data/line.json` in Docker) | Where the line is stored |

## API

| Method | Path | |
|---|---|---|
| `GET` | `/` | The page, with the current line rendered by the server |
| `GET` | `/api/line` | `{ text, updatedAt, changes }` |
| `GET` | `/api/events` | SSE stream of `line` events |
| `POST` | `/api/checkout` | `{ text }` → `{ url }` |
| `POST` | `/api/stripe/webhook` | Stripe webhook |
| `GET` | `/healthz` | Health check |

## Before launch

- **Moderation.** Anyone can post, so expect abuse. `BLOCKED_WORDS` is only a basic filter. Consider a moderation API, or a way for you to remove a line.
- **Terms and content rules.** `public/terms.html` and `public/rules.html` are drafts.
- **Scaling.** State lives in one process and one file. That's fine for a single container. To run more than one copy, move the line into Redis or Postgres and send updates through pub/sub.
