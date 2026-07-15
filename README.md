# Telegram Admin Backend

Production-ready Telegram admin bot backend running on **Vercel Serverless Functions**,
backed by **Firebase Admin SDK / Firestore** and **OpenRouter** for AI.

- **Single API endpoint** — `api/admin.ts` receives every Telegram webhook and every
  programmatic call. All business logic lives in `lib/`.
- **Stateful conversations** — sessions persisted in Firestore (`admin_sessions`).
- **Authoritative wallet service** — the bot never mutates wallet documents directly.
  Every money movement goes through an atomic Firestore transaction with strict
  idempotency (`telegram_timestamp_random` keys).
- **Full audit log** — every admin action is written to `admin_logs`.
- **Inline keyboards only** — slash commands supported (`/start`, `/cancel`) but not required.

## Project structure

```
api/
  admin.ts               ← the only endpoint
lib/
  firebase.ts            ← Firebase Admin singleton (Firestore + Auth)
  auth.ts                ← telegram id / admin secret / firebase bearer auth
  router.ts              ← inbound update → module dispatch (controller layer)
  telegram.ts            ← Bot API client + inline keyboard builder
  callbacks.ts           ← callback_data schema (compact, <64 bytes)
  session.ts             ← stateful conversation + idempotency stores
  users.ts               ← user search / ban / unban / recent activity
  wallet.ts              ← the authoritative wallet service (atomic tx)
  deposit.ts             ← deposit approve / reject workflow
  withdraw.ts            ← withdrawal approve / reject + refund
  poker.ts               ← running tables, kick, refund, end
  reports.ts             ← users / revenue / deposit / withdraw / wallet / games
  broadcast.ts           ← text/image/video/pdf broadcast with buttons
  logs.ts                ← admin audit log (Firestore-backed)
  ai.ts                  ← OpenRouter chat/code/logs/debug
  http.ts                ← fetch wrapper with timeout
  validators.ts          ← wallet + user validation (throws ValidationError)
  response.ts            ← HTTP response helpers
  logger.ts              ← structured JSON logger
  config.ts              ← env validation
  utils.ts               ← small pure helpers
types/
  telegram.ts wallet.ts user.ts
```

## Flow

```
Telegram → Webhook → api/admin.ts → auth → router → module → Telegram response
                                                    ├─ wallet
                                                    ├─ users
                                                    ├─ deposit
                                                    ├─ withdraw
                                                    ├─ poker
                                                    ├─ reports
                                                    ├─ broadcast
                                                    └─ ai
```

## 1. BotFather setup

1. Open [@BotFather](https://t.me/BotFather) and run `/newbot`. Save the token.
2. `/setdescription`, `/setabouttext`, `/setuserpic` — optional but recommended.
3. `/setcommands` — paste:
   ```
   start  - Open the admin panel
   home   - Show the home menu
   cancel - Cancel the current flow
   ```
4. `/setprivacy` → `Disable` (so the bot sees all messages in groups if you use one).
5. Copy the token into `TELEGRAM_BOT_TOKEN`.

## 2. Firebase setup

1. Create a Firebase project. Enable **Firestore** (Native mode) and **Authentication**.
2. Create a service account: **Project settings → Service accounts → Generate new private key**.
3. From the downloaded JSON, copy:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (keep `\n` escapes, wrap in quotes on Vercel)
4. Firestore collections used (created lazily on first write):
   - `admin_sessions`, `admin_logs`, `admin_idempotency`
   - `wallets`, `wallet_transactions`, `wallet_idempotency`
   - `users`, `deposits`, `withdrawals`, `poker_tables`, `game_results`
5. Recommended composite indexes (Firestore will prompt you the first time):
   - `deposits`     (`status ASC`, `createdAt DESC`)
   - `withdrawals`  (`status ASC`, `createdAt DESC`)
   - `wallet_transactions` (`uid ASC`, `createdAt DESC`)
   - `admin_logs`   (`telegramId ASC`, `createdAtMs DESC`)
   - `poker_tables` (`status ASC`)

## 3. OpenRouter setup

1. Sign up at [openrouter.ai](https://openrouter.ai), create an API key.
2. Set `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (e.g. `openai/gpt-4o-mini`),
   and `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` for attribution.

## 4. Environment variables

Copy `.env.example` → `.env` (locally) or set them in the Vercel dashboard under
**Project → Settings → Environment Variables**:

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | Optional — verifies the `X-Telegram-Bot-Api-Secret-Token` header |
| `ADMIN_TELEGRAM_ID` | Primary admin's Telegram user id |
| `ADMIN_TELEGRAM_IDS` | Optional CSV of additional admin ids |
| `ADMIN_SECRET` | Shared secret for programmatic calls (`X-Admin-Secret`) |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK credentials |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | AI provider |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

## 5. Deploy on Vercel

```bash
npm install
npm run typecheck        # sanity check
vercel                   # first-time link
vercel --prod            # deploy to production
```

`vercel.json` maps `/webhook` and `/api/webhook` to `/api/admin` for convenience.

## 6. Register the Telegram webhook

Set the webhook to point at your deployed function. Include the secret header so
only Telegram (and anyone knowing the secret) can invoke it:

```bash
export TELEGRAM_BOT_TOKEN=xxx
export TELEGRAM_WEBHOOK_SECRET=xxx
export WEBHOOK_URL=https://<your-app>.vercel.app/api/admin

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WEBHOOK_URL}" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode "allowed_updates=[\"message\",\"edited_message\",\"callback_query\"]"

# verify
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Or via npm: `npm run set-webhook` (uses `WEBHOOK_URL` + `TELEGRAM_WEBHOOK_SECRET`).

## 7. Testing

### 7.1 Health check
```bash
curl https://<your-app>.vercel.app/api/admin
# → {"ok":true,"service":"telegram-admin-backend"}
```

### 7.2 Unauthorized guard
- Open a chat with your bot from a **non-admin** account and press any button.
  The bot replies `❌ Unauthorized` — no state is mutated.

### 7.3 Wallet flow (from Telegram)
1. `/start` → **💰 Wallet** → **🔎 Lookup User** → send a UID.
2. Tap **➕ Add** → send an amount → send a description → **✅ Confirm**.
3. Verify:
   - New doc in `wallet_transactions`
   - `wallets/<uid>` balance updated
   - `admin_logs` records the action
   - `wallet_idempotency/<key>` prevents retries

### 7.4 Idempotency test (programmatic)
Simulate a duplicate wallet call via the `X-Admin-Secret` header. Both calls
must return the same `txId`; the second flags `duplicate: true`.

```bash
KEY="test_$(date +%s)_deadbeef"
BODY=$(cat <<JSON
{
  "uid": "SOME_UID",
  "action": "ADD",
  "type": "ADD_MONEY",
  "amount": 25,
  "balanceType": "depositBalance",
  "description": "idempotency test",
  "idempotencyKey": "${KEY}"
}
JSON
)
# (Programmatic wallet routing can be added under router.ts if you need direct HTTP wallet mutations — currently walletService.execute is only called from the Telegram flows.)
```

### 7.5 Broadcast dry run
Broadcast targets any user doc in `users/` with a numeric `telegramChatId`.
Seed one test user with your own chat id before running a live broadcast.

## Error handling

Every module returns a `{ ok: false, error }` shape on failure. The router
surfaces the message to the admin as `❌ …`. Uncaught exceptions in `api/admin.ts`
are logged, and Telegram is always acked with `200 OK` to prevent retry storms.

Known error paths:

| Case | Handling |
|---|---|
| Invalid user | `usersService.search` → `❌ User not found.` |
| Invalid UID | `validators.assertUid` throws `ValidationError` |
| Wallet missing | `walletService.getOrCreate` bootstraps a zeroed wallet |
| Duplicate request | Idempotency doc short-circuits, result flagged `duplicate: true` |
| Insufficient balance | `wallet.execute` → `{ok:false, code:'INSUFFICIENT_BALANCE'}` |
| Firebase / API failure | Logged with stack; user sees the message returned by the service |
| Telegram timeout | `httpRequest` aborts after 12s and logs `telegram.api.http_error` |

## Security notes

- The webhook is protected by `TELEGRAM_WEBHOOK_SECRET` (header) **and** admin
  telegram id allowlist. Both checks must pass.
- Programmatic access requires **either** the `X-Admin-Secret` header
  **or** a valid Firebase ID token whose `uid` matches an admin.
- Callback data never carries privileged material — only ids.
- Wallet operations run inside a single Firestore transaction so idempotency
  and balance updates cannot desync.
