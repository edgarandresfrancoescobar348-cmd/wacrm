# Connecting by QR Code (OpenWA)

wacrm can talk to WhatsApp in two ways. Each account uses **one** of them at a
time, chosen in **Settings → WhatsApp**:

| | **API oficial** (Meta Cloud API) | **QR Code** (OpenWA) |
|---|---|---|
| Number | A number registered on Meta's WhatsApp Business Platform | A regular WhatsApp / WhatsApp Business number, linked like WhatsApp Web |
| Setup | Meta app, WABA, access token, webhook | Your own [OpenWA](https://github.com/rmyndharis/OpenWA) gateway: URL + API key, scan a QR code |
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

## Running OpenWA next to wacrm

OpenWA is a separate, self-hosted service (MIT). The bundled compose file has an
optional profile:

```bash
docker compose --profile openwa up -d
docker compose exec openwa cat /app/data/.api-key   # the admin API key (first boot)
```

Then in **Settings → WhatsApp → QR Code**:

1. URL `http://openwa:2785` (inside compose) or wherever your gateway lives, and
   the API key (an `operator` or `admin` key). **Testar conexão** shows the
   gateway version, its engine and the key's role.
2. **Conectar** — wacrm creates its own session on the gateway, registers a
   signed webhook on it and starts it. Scan the QR code (it refreshes until
   scanned) or use **Usar código de pareamento** with the phone number.

The engine (`whatsapp-web.js` — default, lower ban risk — or `baileys`) is a
gateway-wide setting (`ENGINE_TYPE` / `OPENWA_ENGINE_TYPE` in compose). Changing
it means restarting OpenWA and scanning again; message ids differ per engine,
so quoting or reacting to messages from before the switch stops resolving.

### Environment

| Variable | Where | Purpose |
|---|---|---|
| `OPENWA_ALLOWED_HOSTS` | wacrm | Exact hosts/IPs the gateway URL may resolve to although they are private (`127.0.0.1`, `openwa`, `host.docker.internal`). Without it, private/loopback/link-local gateway URLs are refused (SSRF guard). Operator-only, never user input. |
| `OPENWA_WEBHOOK_BASE_URL` | wacrm | Public base URL OpenWA posts events to (default: `NEXT_PUBLIC_SITE_URL`, then the browser's origin). E.g. `http://app:3000` in compose, `http://host.docker.internal:3000` when OpenWA runs in Docker and wacrm on the host. |
| `OPENWA_URL`, `OPENWA_API_KEY` | wacrm | Optional defaults that prefill the form. The key never reaches the browser; leaving the key field empty uses it. |
| `SSRF_ALLOWED_HOSTS` | OpenWA | Must include wacrm's host when it is on a private network, or OpenWA refuses to deliver webhooks to it. |

## Security model

- The gateway URL and API key are stored per account (`whatsapp_openwa_config`),
  the key and the webhook secret encrypted with `ENCRYPTION_KEY`. That table has
  RLS on and **no** client policies: only server routes read it, and they only
  ever return a sanitized state.
- Only owners/admins can save, test, connect, disconnect, request a QR or a
  pairing code, or switch modes. Every route is account-scoped and rate-limited.
- Inbound events arrive at `POST /api/whatsapp/openwa/webhook`. A delivery is
  processed only if its session belongs to an account **and** its
  `X-OpenWA-Signature: sha256=<hex>` is the HMAC-SHA256 of the raw body under
  that account's random 64-character secret (constant-time compare). Anything
  else is `401`. Deliveries are de-duplicated on `X-OpenWA-Idempotency-Key`
  and messages on their id.
- Messages that arrive on the account's inactive connection are stored but no
  flow, automation or AI reply answers them (it would answer from the other
  number).

## Limits

- Pacing state is per server process; a multi-instance deployment paces per
  instance.
- Template quick-reply buttons have no reply mapping in QR mode (they are
  rendered as labels).
- OpenWA has no API to send buttons or lists on either engine, so menus are
  always numbered text.
- A contact known only by a Meta username id (no phone number) can't be reached
  over QR.
