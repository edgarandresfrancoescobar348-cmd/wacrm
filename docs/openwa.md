# Connecting by QR Code (OpenWA)

wacrm can talk to WhatsApp in two ways. Each account uses **one** of them at a
time, chosen in **Settings → WhatsApp**:

| | **API oficial** (Meta Cloud API) | **QR Code** (OpenWA) |
|---|---|---|
| Number | A number registered on Meta's WhatsApp Business Platform | A regular WhatsApp / WhatsApp Business number, linked like WhatsApp Web |
| Setup | Meta app, WABA, access token, webhook | Nothing: press **Conectar** and scan a QR code. The gateway ([OpenWA](https://github.com/rmyndharis/OpenWA)) ships inside wacrm |
| Templates | Submitted to Meta, sent once approved | Local: ready as soon as saved, rendered and sent as text (media header → media with caption) |
| 24 h window | Applies (free-form text only within 24 h of the customer's last message) | Does not exist — reply any time |
| Buttons / lists | Native interactive messages | A numbered text menu; the reply (number or option title, case/accent-insensitive) triggers the same option |
| Broadcasts | Meta's rate limits | Sent one by one with a mandatory gap (default 8 s + up to 30 % jitter, 3–120 s per account) |
| Groups / status | — | Ignored (no conversations are created) |
| Official / supported by Meta | Yes | **No** — see the ban-risk note below |

Switching modes keeps every contact and conversation. The inactive mode's
settings stay saved, so switching back is one click ("Usar este modo").

## ⚠️ Ban risk

A QR-code connection drives a normal WhatsApp account through an unofficial
client. WhatsApp may restrict or ban the number at any time, especially when
it sends bulk messages to people who never wrote first.

- Use a number dedicated to customer service, never your personal one.
- Don't blast cold lists; reports are what get numbers banned.
- Keep the broadcast gap (Settings → WhatsApp → QR Code) and start small.
- When WhatsApp restricts the number, Settings shows a red notice
  (OpenWA's `session.restriction` event) — stop bulk sends until it lifts.

## The embedded gateway

The QR-code mode talks to WhatsApp through [OpenWA](https://github.com/rmyndharis/OpenWA)
(MIT), **vendored in this repo** under `packages/openwa` (v0.25.0, `git subtree`)
and started together with wacrm. There is no URL or API key to enter anywhere:
wacrm owns the gateway, provisions its admin key on first run and hands it to
both sides.

In **Settings → WhatsApp → QR Code**: choose the mode → **Conectar** → scan the
QR code (it refreshes until scanned), or use **Usar código de pareamento** with
the phone number. wacrm creates the account's own session on the gateway,
registers a signed webhook on it and starts it. Every account gets its own
session on the one gateway.

If the gateway is not running, not reachable, or refuses the server key, the
QR card says so (with **Verificar de novo**) instead of offering **Conectar**.

### How it runs

| | Gateway | Key | Webhooks |
|---|---|---|---|
| `npm run dev` | `scripts/wacrm.mjs` installs `packages/openwa` (its own lockfile, `npm ci`, first run only), builds it and runs it on `127.0.0.1:2785` next to `next dev`. Data: `.openwa-data/` (gitignored) | Generated once into `.openwa-data/gateway.key` (`0600`) | `http://127.0.0.1:<next port>` |
| `npm run build` / `npm run start` | `build` also builds the gateway; `start` runs it next to `next start` (`NODE_ENV=production`) | same | same |
| `docker compose up` | The `openwa` service, built from `./packages/openwa`. Its port is **not published**; only `app` reaches it at `http://openwa:2785` | The one-shot `openwa-key` service writes it into the `gateway-key` volume, mounted read-only by `app` (`OPENWA_API_KEY_FILE`) and `openwa` | `http://app:3000` |

The gateway needs two native pieces that come from install scripts: the
Chrome that `puppeteer` downloads (whatsapp-web.js engine) and
`better-sqlite3`'s binding. npm 11 runs a dependency's install scripts only
when `allowScripts` covers it, so `packages/openwa/package.json` approves
exactly those (plus `msgpackr-extract` and Baileys' engine check) and denies
the rest — `@scarf/scarf` telemetry included. Before starting, the runner
checks that Chrome and the SQLite binding exist and stops with the fix
(`npm run openwa:install`, or `PUPPETEER_EXECUTABLE_PATH` for a system Chrome)
when they don't. Changing `allowScripts` reinstalls the gateway's
dependencies on the next start.

In dev/start, Ctrl-C (or either process exiting) stops both.

### Sessions after a restart

The runner and compose start the gateway with `AUTO_START_SESSIONS=true`
(opt-in upstream): on boot OpenWA restarts every session that was linked when
it went down — phone known, status disconnected, not stopped by an operator —
from its saved WhatsApp Web auth, so restarting `npm run dev` / the container
brings the number back to "Conectado" by itself (the settings card follows it
while it reconnects). A session that never finished pairing (QR shown, never
scanned) and one an admin disconnected are not restarted. Turn it off with
`OPENWA_AUTO_START_SESSIONS=false`.

### The scheduler

"One start" includes the cron: `npm run dev` / `npm run start` tick every
60 s (`WACRM_CRON_INTERVAL_S`) — `/api/automations/cron` and
`/api/whatsapp/broadcast/cron` each tick, `/api/flows/cron` every 5th — with
the cron secret: `AUTOMATION_CRON_SECRET` from the environment or `.env*`
files, else one generated once into `.openwa-data/cron.secret` (`0600`) and
handed to Next. One log line per tick (`[cron] tick 3: automations 200 ·
broadcast 200 (44 ms)`); it stops with the app. Compose runs the same loop
as the `scheduler` service (docs/docker.md). Serverless hosts keep their own
cron configuration. `WACRM_CRON=off` turns it off.

### Gateway rate limit

OpenWA throttles each client IP (Nest throttler; stock 10/s, 100/min,
1000/h). wacrm is the embedded gateway's only client and its API is
internal, so the runner and compose raise those to 20/s, 600/min and
36 000/h and hand the per-minute/per-hour values to Next
(`OPENWA_RATE_LIMIT_PER_MIN` / `_PER_HOUR`). The history import uses 40 % of
the tighter one (240 calls/min here; ~6.7/min against a stock gateway),
leaving the rest to live traffic. `npm run dev -- -p 4000`
passes arguments to Next; the webhook URL follows the port.

**QR mode needs a long-running host.** The gateway keeps a WhatsApp Web session
(a headless Chrome on whatsapp-web.js) open around the clock, so it runs on a
VPS, a container host or your machine — not on serverless platforms. On
Vercel (detected automatically) or with `WACRM_OPENWA=off`, wacrm starts
without it: the official API mode works and the QR card says the gateway is
not available on this server.

The engine (`whatsapp-web.js` — default, lower ban risk — or `baileys`) is
deployment-wide: `OPENWA_ENGINE_TYPE`. Changing it means restarting wacrm and
scanning again; message ids differ per engine, so quoting or reacting to
messages from before the switch stops resolving.

### Gateway key

OpenWA seeds its admin key from `API_MASTER_KEY` on its **first** boot (empty
key table) and keeps it in its own database afterwards. The start script and
the compose `openwa-key` step generate that key once and pass the same value to
OpenWA (as `API_MASTER_KEY`) and to wacrm (`OPENWA_API_KEY` /
`OPENWA_API_KEY_FILE`). A data dir an older OpenWA already seeded keeps its key:
the start step adopts `data/.api-key` from it when no key file exists yet.

If the gateway ever rejects the key ("refuses the server key" on the QR card,
or `rejected the provisioned key` in the dev log), the gateway's data was
seeded with a different key: put that key in `.openwa-data/gateway.key`
(compose: the `gateway-key` volume), or start over with an empty data dir —
which unlinks every QR session.

### Environment

| Variable | Purpose |
|---|---|
| `WACRM_OPENWA=off` | Run without the gateway (QR mode unavailable). Automatic on Vercel. |
| `OPENWA_PORT` | Gateway port in dev/start (default `2785`, loopback only). |
| `WACRM_OPENWA_DATA_DIR` | Gateway data dir in dev/start (default `.openwa-data`). |
| `OPENWA_ENGINE_TYPE` | `whatsapp-web.js` (default) or `baileys`. |
| `OPENWA_URL`, `OPENWA_API_KEY` / `OPENWA_API_KEY_FILE`, `OPENWA_WEBHOOK_BASE_URL` | Set by the start script / compose. Only set them yourself to run the gateway elsewhere on your own infrastructure (e.g. a separate container); they are server config, never user input. |

Running Node directly (`next start` without the script) means no gateway unless
you provide those variables. The gateway needs Node ≥ 22.19.

### Updating the vendored OpenWA

```bash
git subtree pull --prefix packages/openwa https://github.com/rmyndharis/OpenWA.git v0.26.0 --squash
npm run openwa:install && npm run openwa:build
```

wacrm carries local patches on top of upstream; keep them when resolving
conflicts (each is marked `wacrm patch` in the source):

- `LISTEN_HOST` binds the API to loopback in dev/start (`src/main.ts`).
- `allowScripts` in `packages/openwa/package.json` (npm 11 install scripts).
- History media and on-demand download: metadata-only history reads carry the
  media marker (mimetype, filename, size, duration, page count, JPEG preview);
  `downloadMessageMedia` (whatsapp-web.js) lets `GET …/:messageId/media`
  download a never-archived message's media from WhatsApp (410 expired, 413
  over the cap, 504 timeout).
- Messages carry `ack` (ticks), `isForwarded` / `forwardingScore`. Re-run the QR flow (connect, receive, send) after an
update: the client in `src/lib/whatsapp/openwa/client.ts` targets the v0.25 API.

## Security model

- The gateway is wacrm's own: its URL and admin key are server config
  (`lib/whatsapp/openwa/gateway.ts`), never typed by a user and never sent
  to the browser. The per-account row (`whatsapp_openwa_config`) holds the
  session id, state, pacing and the webhook secret (encrypted with
  `ENCRYPTION_KEY`). That table has RLS on and **no** client policies: only
  server routes read it, and they only ever return a sanitized state.
- The gateway is not reachable from outside: loopback in dev/start, an
  unpublished compose port in Docker.
- Only owners/admins can connect, disconnect, request a QR or a
  pairing code, change the pacing, or switch modes. Every route is account-scoped; the admin
  routes are rate-limited per user (20/min for actions, 40/min for QR/status
  polling). The member read routes (state, media proxy) and the signed webhook
  have no limiter of their own.
- Media proxied from the gateway is served inline only for inert types
  (images, audio, video); anything else downloads as
  `application/octet-stream`, always with `nosniff` and a sandboxing CSP.
- Inbound events arrive at `POST /api/whatsapp/openwa/webhook`. A delivery is
  processed only if its session belongs to an account **and** its
  `X-OpenWA-Signature: sha256=<hex>` is the HMAC-SHA256 of the raw body under
  that account's random 64-character secret (constant-time compare). Anything
  else is `401`. The durable part (message, ticks, session state) is
  processed inside the request; a transient failure answers `503` so OpenWA
  redelivers, and only a delivery that **completed** is answered `duplicate`
  afterwards (ledger states `processing`/`done`/`failed`). Bots (flows,
  automations, AI) run after that, in the background. Messages are also
  de-duplicated on their id.
- Messages that arrive on the account's inactive connection are stored but no
  flow, automation or AI reply answers them (it would answer from the other
  number).
- An inbound message's fan-out (flows, automations, AI reply, the public
  `message.received` webhook) is a durable task written together with the
  message (migration 057). It runs right after the delivery is processed; if
  that doesn't happen (the delivery couldn't be marked done, the process
  died), a redelivery of the message or the cron above runs it — once, and
  steps already run are not repeated. A step that fails transiently is
  retried later (a public webhook only to the endpoints that missed it,
  with the same delivery id); one whose outcome is uncertain stops the task
  for a person (status `held`) instead of risking a duplicate.
- The account's "connected" flag is derived in the database from the
  session state (migration 058), so it can't fall behind a newer session
  event.

## Chat history import

When a QR session becomes ready (and from **Importar de novo** in Settings →
WhatsApp → QR Code), wacrm imports the individual chats the linked phone
holds: `GET /sessions/:id/chats` (one-to-one chats and groups; channels,
status and broadcasts are skipped), then per chat `GET …/messages/:chatId/history?deep=true`. On
engines without live history (Baileys answers 501) only the messages the
gateway stored are imported, and the page says the history is limited.

- Connecting only **queues** it; the scheduler tick runs it (within a
  minute). Right after pairing, whatsapp-web.js loads the chat list from the
  phone first — the first `/chats` can take 90 s or more. The list call
  waits up to 180 s (never past the run's deadline); if it still has no
  answer the job waits ("Aguardando o WhatsApp carregar as conversas…
  próxima tentativa às HH:MM") and retries 30 s later.
- Runs in bounded steps (one cron run, ≤ 280 s, then the next tick),
  resumable (per-chat checkpoints, migration 063), most recent chats first;
  the inbox shows each conversation as it lands, most recent first.
- Respects the gateway's rate limit (above): every call is paced, a 429
  waits what `Retry-After*` says (and holds back every import call), and a
  gateway that keeps refusing pauses the run until then. A chat that hits a
  429, a timeout or a 5xx goes back to the queue — never a definitive error;
  chats an older version marked failed for those reasons are requeued on
  the next run. A disconnected session waits.
- A chat whose history has nothing to show (only WhatsApp's content-less
  placeholders, or only messages newer than the import) creates no contact
  and no conversation; it counts as skipped. Migration 065 removes the empty
  conversations earlier versions created (only untouched ones the import
  made). Conversations without messages never sit above those with them.
- `errors` is the number of chats that are still failed at the end (not
  attempts); with none, the last error is cleared.
- **Media opens.** Every imported photo, video, audio/voice note, document
  and sticker keeps a reference to the gateway's media route, even when the
  history said nothing about the file. On first open the gateway downloads it
  from WhatsApp (wacrm patch, below), wacrm serves it with the same inert-type
  rules as live media and keeps a copy in storage when "Guardar cópia das
  mídias recebidas" is on, so the next open doesn't go to WhatsApp. When
  WhatsApp no longer has a file the bubble says "mídia expirada no WhatsApp".
  Migration 066 gave the rows imported before this their reference.
- @mentions of a privacy id (`@154112083632297`) read as the contact's name or
  number, like WhatsApp Web (resolved through the gateway, cached).
- Never a silent stall: every run that stops leaves its reason and next
  attempt on the job (`last_error`, `next_run_at`) and logs a
  `[history import]` line; a run whose process died is picked up again when
  its lease (6 min) expires; the card says when the scheduler hasn't run it
  for a while.
- Idempotent: messages are keyed by the provider message id, so a re-run or
  a webhook delivering the same message never duplicates it. Messages newer
  than the import's start are left to the webhooks.
- Imported messages never run bots, automations, flows, AI, public
  webhooks or notifications and never add to unread — each conversation
  takes the phone's unread count. Media is a lazy reference through the
  media proxy, downloaded only when opened.
- WhatsApp's link-time placeholders (type `unknown`, no content) are
  skipped here and on the webhook.

## WhatsApp parity (QR Code inbox)

The QR-code inbox follows the linked phone (migration 067):

- **Names** like the phone: the saved address-book name, else the business's
  verified name, else the sender's own profile name shown as `~Name`, else
  the number formatted (`+55 62 99842-3737`). `contacts.name_source` says
  where the name came from; a name a wacrm user typed (`manual`, set by a
  trigger for every edit from the app) is never overwritten by WhatsApp.
- **Ticks** from WhatsApp's `ack`, in the import and live (sent ✓, delivered
  ✓✓, read blue ✓✓, played).
- **Groups** are listed like on the phone — name, sender name per message
  in a stable colour, preview `Luciana Alves: …`, replies — and you can
  answer in them. They are not CRM contacts and never run bots, automations,
  flows, AI, broadcasts or the public API (`/api/v1` lists no groups).
  Status, broadcast lists and channels stay out.
- **Message details:** "Encaminhada" / "Encaminhada com frequência"; a
  document's first-page preview and "1 página · 2 MB · pdf"; photo and video
  previews before the download; a voice note's length before it loads, green
  mic while unplayed and blue once played (`media_meta.played`); a deleted
  message reads "Mensagem apagada"; the "Mensagem não lida/não ouvida: N"
  line where the unread messages begin. Previews: "Mensagem de voz (0:09)",
  "x.pdf · 1 página", "4 fotos", "Mensagem apagada".
- **The chat list:** archived chats sit under "Arquivadas" (and out of the
  unread total), pinned chats on top, then WhatsApp's order; each chat's
  unread count is the phone's. The gateway sends no webhook for archiving,
  pinning or reading on the phone, so the scheduler re-reads the chat list
  (≤ once a minute per account, paced) and mirrors archived, pinned, unread,
  group names and saved names. Opening a chat in wacrm marks it read on the
  phone (`POST /api/whatsapp/openwa/read`).
- **Session state** never goes backwards: a session event older than the
  last one applied is ignored (its time is the event's, not the redelivery's),
  and while the row says disconnected the inbox re-checks the gateway
  (`GET /api/whatsapp/openwa?verify=1`, at most every 20 s).

## Limits

- Pacing state is per server process; a multi-instance deployment paces per
  instance.
- A paced broadcast never runs a request past its time limit. Each pass
  prepares a media header before reserving a paced slot, only starts sends
  that can finish inside the request (the gateway call is aborted at the
  budget, DNS check included).
- **Every broadcast send has a durable send attempt** (migration 056): its
  own idempotency key and frozen payload, recorded BEFORE anything is sent —
  if that checkpoint can't be written, nothing is sent. A retry of the same
  attempt resends the identical request with the identical key; a new key
  exists only as a new attempt after the previous one is known to have
  failed. OpenWA's "still running" (409 `IDEMPOTENCY_KEY_IN_PROGRESS`) keeps
  the attempt and retries later with the same key.
- A send whose outcome can't be established (gateway timeout, lost answer,
  409 `IDEMPOTENCY_OUTCOME_UNKNOWN`) is **reconciled before anything is sent
  again**: the gateway's `message.sent` echo, a stored message or the
  gateway's message history. It is resent automatically only within
  OpenWA's 24 h idempotency window (minus a margin) and only to the same
  gateway URL and session. Otherwise — and always on the official API,
  which has no idempotency key — the recipient is shown as **Unconfirmed**
  on the broadcast page, where a person records "They arrived" or "Not sent
  (allow retry)" after checking the chat. Evidence only counts when it is
  unambiguous: one provider message confirms at most one send, and a match
  by text with more than one candidate goes to a person. A refusal that
  provably happened before sending (rate limit, out of time) is simply sent
  on the next pass; an answer that can't be read is treated as "may have
  been sent". Failures recorded before send attempts existed that had
  already started sending are shown as Unconfirmed instead of being
  retried.
- What doesn't fit a pass stays `pending` and **continues automatically**
  on the next run of the scheduler you already use for automations
  (`GET /api/automations/cron`, or the dedicated
  `GET /api/whatsapp/broadcast/cron`, both with `x-cron-secret`) — also for
  broadcasts created through the public API and for leftovers of the
  dashboard wizard. The schedule is kept until nothing is pending; a pass
  that can't run is retried with a backoff. **Resume** still works for an
  immediate pass; "Retry failed" makes the failed recipients resumable
  before its pass starts. Without a configured scheduler, paused broadcasts
  wait for Resume.
- Template quick-reply buttons have no reply mapping in QR mode (they are
  rendered as labels).
- OpenWA has no API to send buttons or lists on either engine, so menus are
  always numbered text.
- A contact known only by a Meta username id (no phone number) can't be reached
  over QR.
