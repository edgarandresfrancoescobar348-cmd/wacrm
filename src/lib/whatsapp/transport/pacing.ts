// ============================================================
// Broadcast pacing — a minimum, slightly randomised gap between two
// broadcast sends from the same account.
//
// Meta's Cloud API rate-limits on its side, so its transport asks for
// no delay (`broadcastDelayMs: 0`) and this is a no-op there. A regular
// WhatsApp number paired by QR code (OpenWA) has no such protection:
// a burst of identical messages to people who never wrote first is the
// fastest way to get the number banned. Every broadcast path (the
// dashboard wizard's batches, the public API, resume) waits here before
// each send, so the gap holds across batches and across requests.
//
// State is per server process. A multi-instance deployment paces per
// instance — documented in the README next to the ban-risk note.
// ============================================================

const lastSendAt = new Map<string, number>()

export interface PaceOptions {
  /**
   * Epoch ms after which this send must not START (the handler's time
   * budget). When the pacing gap would push the start past it, nothing
   * is reserved and `paceBroadcastSend` resolves `false` — the caller
   * stops and leaves the rest for a resume pass.
   */
  deadline?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 0..1; defaults to Math.random. */
  random?: () => number
}

/** Up to +30% jitter so the cadence doesn't look machine-regular. */
export const PACING_JITTER = 0.3

/**
 * Wait until at least `delayMs` (+ jitter) has passed since the last
 * paced send for `key`, then record this send. Resolves `true` when the
 * send may go out now, `false` when it would start after
 * `opts.deadline` (nothing reserved, nothing waited).
 */
export async function paceBroadcastSend(
  key: string,
  delayMs: number,
  opts: PaceOptions = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now
  if (opts.deadline !== undefined && now() >= opts.deadline) return false
  if (!(delayMs > 0)) return true
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = opts.random ?? Math.random

  const gap = Math.round(delayMs * (1 + PACING_JITTER * random()))
  const last = lastSendAt.get(key)
  // Reserve the slot before sleeping so two concurrent callers for the
  // same account queue up instead of both waking at the same instant.
  const startAt = last === undefined ? now() : Math.max(now(), last + gap)
  if (opts.deadline !== undefined && startAt > opts.deadline) return false
  lastSendAt.set(key, startAt)
  const wait = startAt - now()
  if (wait > 0) await sleep(wait)
  return true
}

/**
 * Time a send needs after it starts: OpenWA answers within its 45 s send
 * timeout (simulated typing included), plus margin for our own writes.
 */
export const SEND_RESERVE_MS = 50_000

/**
 * The last moment a broadcast send may START inside a handler that
 * started at `startedAt` and may run `maxDurationSeconds`. Sends planned
 * past it are left `pending` — the checkpoint the resume pass picks up —
 * so a paced broadcast never runs the handler past its limit.
 */
export function broadcastSendDeadline(
  maxDurationSeconds: number,
  startedAt: number = Date.now(),
): number {
  return startedAt + maxDurationSeconds * 1000 - SEND_RESERVE_MS
}

/** Test hook. */
export function resetBroadcastPacing(): void {
  lastSendAt.clear()
}
