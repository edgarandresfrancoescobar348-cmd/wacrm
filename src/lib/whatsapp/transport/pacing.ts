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
  // A timer can fire late (a busy event loop, a suspended worker): check
  // the deadline again before letting the send start.
  if (opts.deadline !== undefined && now() > opts.deadline) return false
  return true
}

/** Kept free at the end of the handler for the result writes. */
export const PERSIST_RESERVE_MS = 10_000

/**
 * Time a send needs once it starts: the provider call (OpenWA answers
 * within its 45 s send timeout, simulated typing included) — media is
 * prepared BEFORE the slot is reserved — plus the persist reserve.
 */
export const SEND_RESERVE_MS = 45_000 + PERSIST_RESERVE_MS

/**
 * The last moment a broadcast send may START inside a handler that
 * started at `startedAt` and may run `maxDurationSeconds`. Sends planned
 * past it are left `pending` — the checkpoint the next pass (cron
 * continuation or Resume) picks up.
 */
export function broadcastSendDeadline(
  maxDurationSeconds: number,
  startedAt: number = Date.now(),
): number {
  return startedAt + maxDurationSeconds * 1000 - SEND_RESERVE_MS
}

/**
 * The absolute moment every provider call of the pass must have
 * finished (`sendBy`): the handler limit minus the persist reserve. The
 * transports abort at it, so no send outlives the handler.
 */
export function broadcastSendBy(
  maxDurationSeconds: number,
  startedAt: number = Date.now(),
): number {
  return startedAt + maxDurationSeconds * 1000 - PERSIST_RESERVE_MS
}

/** Test hook. */
export function resetBroadcastPacing(): void {
  lastSendAt.clear()
}

/**
 * How many of a plan's recipients one pass can START before `deadline`
 * at the transport's pacing (the first goes immediately; each next one
 * waits at least the delay). An estimate for `remaining` in responses —
 * the authoritative checkpoint is the recipients' status.
 */
export function estimatePassCapacity(
  plan: { planned: unknown[]; transport: { capabilities: { broadcastDelayMs: number } } },
  deadline: number,
  now: number = Date.now(),
): number {
  const total = plan.planned.length
  const delay = plan.transport.capabilities.broadcastDelayMs
  if (!(delay > 0)) return total
  if (now > deadline) return 0
  return Math.min(total, Math.floor((deadline - now) / delay) + 1)
}
