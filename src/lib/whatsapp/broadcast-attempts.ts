// ============================================================
// Broadcast send attempts — the durable identity of one send to one
// broadcast recipient (migration 069; third review H3, H5, H6, H7).
//
// Every path that sends a broadcast message (the public API's passes,
// Resume, the cron continuation, the dashboard wizard's batches) goes
// through `sendBroadcastRecipient`, which:
//
//   1. prepares the recipient's attempt — its OPEN attempt if there is
//      one (same idempotency key, same frozen payload), else a new one;
//   2. reconciles an attempt that already reached the provider and whose
//      outcome is unknown (stored message, gateway history) and refuses
//      to resend it outside the provider's de-duplication guarantee —
//      that recipient goes to a human decision instead;
//   3. claims the attempt (`begin` — the checkpoint) and only then sends.
//      No claimed row back from the database: no send;
//   4. records what the try established: sent, definitely not sent,
//      still running at the gateway (backoff, same key), or unknown.
//
// Every write is checked. A write that fails stops the caller's pass
// (AttemptStoreError); the attempt then stays as the database last
// knew it and the next pass reconciles it.
// ============================================================

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { OpenWaError } from '@/lib/whatsapp/openwa/client'
import {
  SendBudgetExceededError,
  UncertainSendError,
  sendWithRecipientVariants,
  type SendTemplateArgs,
  type WhatsAppTransport,
} from '@/lib/whatsapp/transport'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import type { MessageTemplate } from '@/types'

/** What is sent — frozen on the attempt, identical on every try of it. */
export interface FrozenTemplateSend {
  to: string
  templateName: string
  language: string
  template: MessageTemplate | null
  params: string[]
  messageParams?: SendTimeParams
}

export type AttemptState = 'pending' | 'in_flight' | 'sent' | 'failed' | 'unknown'

export interface SendAttempt {
  id: string
  account_id: string
  broadcast_id: string
  recipient_id: string
  attempt_no: number
  idempotency_key: string
  provider: 'meta' | 'openwa'
  gateway_url: string | null
  gateway_session_id: string | null
  to_phone: string
  payload: FrozenTemplateSend
  payload_hash: string
  expected_body: string | null
  state: AttemptState
  needs_decision: boolean
  first_sent_at: string | null
  started_at: string | null
  lease_until: string | null
  next_retry_at: string | null
  tries: number
  provider_message_id: string | null
  error_code: string | null
  error_message: string | null
}

/** A write the attempt model depends on failed — stop the pass. */
export class AttemptStoreError extends Error {
  constructor(step: string, cause?: { message?: string } | null) {
    super(`send attempt ${step} failed${cause?.message ? `: ${cause.message}` : ''}`)
    this.name = 'AttemptStoreError'
  }
}

/** Resends stop this long before the provider forgets the key. */
export const RESEND_WINDOW_MARGIN_MS = 60 * 60 * 1000
/** First backoff for a key the gateway reports as still running. */
export const IN_PROGRESS_BACKOFF_MS = 60_000
const IN_PROGRESS_BACKOFF_MAX_MS = 15 * 60_000
/** When an unknown-but-resendable attempt is looked at again. */
export const UNKNOWN_RETRY_MS = 30_000
/** A claimed try is held this long past its send deadline. */
const LEASE_SLACK_MS = 60_000

const REFUSED_KEY_CODES = new Set(['IDEMPOTENCY_OUTCOME_UNKNOWN', 'IDEMPOTENCY_KEY_REUSED'])

/** Canonical JSON (sorted keys) → sha256, for the frozen payload. */
export function hashPayload(payload: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v
  return crypto.createHash('sha256').update(JSON.stringify(canon(payload))).digest('hex')
}

// ---------------------------------------------------------------
// Classification of a failed try
// ---------------------------------------------------------------

export type TryOutcome =
  /** Definitely not sent — the attempt is over. */
  | { kind: 'failed'; code: string | null; message: string }
  /** May have been sent. `resendable`: the provider can still tell. */
  | { kind: 'unknown'; code: string | null; message: string; resendable: boolean }
  /** The gateway still runs a request with this key: same key, later. */
  | { kind: 'in_progress'; code: string | null; message: string }
  /** Refused before sending (rate limit, out of budget): same key, later. */
  | { kind: 'retry_later'; code: string | null; message: string; outOfBudget: boolean }

function isNetworkFailure(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'TimeoutError' || err.name === 'AbortError'
  return err instanceof TypeError // fetch failed: connection reset, DNS, …
}

export function classifySendError(transport: WhatsAppTransport, err: unknown): TryOutcome {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof SendBudgetExceededError) {
    // Thrown before the request left (no time left to start it).
    return { kind: 'retry_later', code: 'budget', message, outOfBudget: true }
  }
  if (err instanceof UncertainSendError || err instanceof SyntaxError) {
    // Accepted by the provider, answer unreadable (K7): the message may
    // be out. Same key next time (where the provider de-duplicates).
    return { kind: 'unknown', code: 'response_unreadable', message, resendable: transport.capabilities.idempotentSends }
  }
  const idempotent = transport.capabilities.idempotentSends
  if (err instanceof OpenWaError) {
    if (err.code === 'IDEMPOTENCY_KEY_IN_PROGRESS') return { kind: 'in_progress', code: err.code, message }
    if (err.code && REFUSED_KEY_CODES.has(err.code)) {
      // The gateway won't run this key again: only reconciliation or a
      // person can tell whether it went out.
      return { kind: 'unknown', code: err.code, message, resendable: false }
    }
    if (err.status === 429) return { kind: 'retry_later', code: 'rate_limited', message, outOfBudget: false }
    // 0 = no answer (timeout, reset); 5xx and 408/409 from the engine may
    // have gone through. The gateway arbitrates a resend with the key.
    if (err.status === 0 || err.status === 408 || err.status === 409 || (err.status >= 500 && err.status !== 501)) {
      return { kind: 'unknown', code: err.code ?? `http_${err.status}`, message, resendable: idempotent }
    }
    return { kind: 'failed', code: err.code ?? `http_${err.status}`, message }
  }
  if (err instanceof MetaApiError) {
    if (err.httpStatus === 429) return { kind: 'retry_later', code: 'rate_limited', message, outOfBudget: false }
    if (err.httpStatus >= 500) return { kind: 'unknown', code: `http_${err.httpStatus}`, message, resendable: idempotent }
    return { kind: 'failed', code: err.code !== null ? String(err.code) : `http_${err.httpStatus}`, message }
  }
  if (isNetworkFailure(err)) return { kind: 'unknown', code: 'no_response', message, resendable: idempotent }
  // Anything else was thrown before a request (validation, rendering).
  return { kind: 'failed', code: null, message }
}

// ---------------------------------------------------------------
// Store operations (all checked)
// ---------------------------------------------------------------

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null
  return (data as T) ?? null
}

export async function prepareAttempt(
  db: SupabaseClient,
  accountId: string,
  recipientId: string,
  transport: WhatsAppTransport,
  payload: FrozenTemplateSend,
): Promise<SendAttempt | null> {
  const { data, error } = await db.rpc('broadcast_attempt_prepare', {
    p_account_id: accountId,
    p_recipient_id: recipientId,
    p_provider: transport.provider,
    p_to_phone: payload.to,
    p_payload: payload,
    p_payload_hash: hashPayload(payload),
    p_expected_body: transport.expectedBody?.(toSendArgs(payload)) ?? null,
  })
  if (error) throw new AttemptStoreError('prepare', error)
  return firstRow<SendAttempt>(data)
}

function resendWindowMs(transport: WhatsAppTransport): number | null {
  const window = transport.capabilities.idempotencyWindowMs ?? 0
  if (!transport.capabilities.idempotentSends || window <= RESEND_WINDOW_MARGIN_MS) return null
  return window - RESEND_WINDOW_MARGIN_MS
}

/**
 * May this attempt, which already reached the provider, be sent again
 * with its key? Only inside the provider's de-duplication window, to the
 * same gateway + session, and if the gateway hasn't refused the key.
 */
export function canResend(attempt: SendAttempt, transport: WhatsAppTransport, now: number): boolean {
  if (!attempt.first_sent_at) return true
  const window = resendWindowMs(transport)
  if (window === null) return false
  if (attempt.error_code && REFUSED_KEY_CODES.has(attempt.error_code)) return false
  if (!transport.gateway) return false
  if (attempt.gateway_url !== transport.gateway.url) return false
  if (attempt.gateway_session_id !== transport.gateway.sessionId) return false
  return now - Date.parse(attempt.first_sent_at) < window
}

export async function beginAttempt(
  db: SupabaseClient,
  accountId: string,
  attempt: SendAttempt,
  transport: WhatsAppTransport,
  leaseUntil: number,
): Promise<SendAttempt | null> {
  const window = resendWindowMs(transport)
  const { data, error } = await db.rpc('broadcast_attempt_begin', {
    p_account_id: accountId,
    p_attempt_id: attempt.id,
    p_lease_until: new Date(leaseUntil).toISOString(),
    p_gateway_url: transport.gateway?.url ?? null,
    p_gateway_session_id: transport.gateway?.sessionId ?? null,
    p_resend_window: window === null ? null : `${Math.floor(window / 1000)} seconds`,
  })
  if (error) throw new AttemptStoreError('begin', error)
  const claimed = firstRow<SendAttempt>(data)
  // The checkpoint must be the row we asked for, on our account.
  if (claimed && (claimed.id !== attempt.id || claimed.account_id !== accountId)) {
    throw new AttemptStoreError('begin (unexpected row)')
  }
  return claimed
}

export async function finishAttempt(
  db: SupabaseClient,
  accountId: string,
  attempt: Pick<SendAttempt, 'id' | 'started_at'>,
  outcome:
    | { kind: 'sent'; messageId: string | null; resolvedBy?: 'provider' | 'history' }
    | { kind: 'failed' | 'in_progress' | 'retry_later'; code: string | null; message: string; retryAt?: number }
    | { kind: 'unknown'; code: string | null; message: string; retryAt?: number; needsDecision: boolean },
): Promise<string> {
  const { data, error } = await db.rpc('broadcast_attempt_finish', {
    p_account_id: accountId,
    p_attempt_id: attempt.id,
    p_started_at: attempt.started_at,
    p_outcome: outcome.kind,
    p_message_id: outcome.kind === 'sent' ? outcome.messageId : null,
    p_error_code: outcome.kind === 'sent' ? null : outcome.code,
    p_error_message: outcome.kind === 'sent' ? null : outcome.message,
    p_retry_at:
      outcome.kind !== 'sent' && 'retryAt' in outcome && outcome.retryAt !== undefined
        ? new Date(outcome.retryAt).toISOString()
        : null,
    p_needs_decision: outcome.kind === 'unknown' ? outcome.needsDecision : false,
    p_resolved_by: outcome.kind === 'sent' ? (outcome.resolvedBy ?? 'provider') : null,
  })
  if (error) throw new AttemptStoreError(`finish (${outcome.kind})`, error)
  return String(data)
}

export async function holdAttempt(
  db: SupabaseClient,
  accountId: string,
  attempt: SendAttempt,
  reason: string,
): Promise<void> {
  const { error } = await db.rpc('broadcast_attempt_hold', {
    p_account_id: accountId,
    p_attempt_id: attempt.id,
    p_error_message: reason,
  })
  if (error) throw new AttemptStoreError('hold', error)
}

export type Reconciliation =
  | { kind: 'sent'; messageId: string }
  /** Evidence exists but does not single this attempt out — held for a person. */
  | { kind: 'ambiguous' }
  | { kind: 'none' }

function settled(data: unknown): Reconciliation {
  const r = (data ?? {}) as { outcome?: string; message_id?: string }
  if (r.outcome === 'sent' && r.message_id) return { kind: 'sent', messageId: r.message_id }
  if (r.outcome === 'ambiguous') return { kind: 'ambiguous' }
  return { kind: 'none' }
}

/**
 * Establish an unknown attempt's outcome from what we can see: a stored
 * outgoing message (an echo already recorded), then the gateway's
 * history of the SAME gateway and session. Evidence settles the attempt
 * only when unambiguous: exactly one unreserved message and no other
 * open send that could own it (broadcast_attempt_settle_evidence, K2);
 * otherwise the attempt is held for a person.
 */
export async function reconcileAttempt(
  db: SupabaseClient,
  accountId: string,
  attempt: SendAttempt,
  transport: WhatsAppTransport,
): Promise<Reconciliation> {
  const { data: stored, error } = await db.rpc('broadcast_attempt_reconcile_stored', {
    p_account_id: accountId,
    p_attempt_id: attempt.id,
  })
  if (error) throw new AttemptStoreError('reconcile (stored)', error)
  const fromStore = settled(stored)
  if (fromStore.kind !== 'none') return fromStore

  if (!attempt.expected_body || !attempt.first_sent_at || !transport.findSentMessages) return { kind: 'none' }
  if (attempt.provider !== transport.provider) return { kind: 'none' }
  // History belongs to one gateway AND session: another one's history
  // proves nothing about this attempt.
  if (
    !transport.gateway ||
    attempt.gateway_url !== transport.gateway.url ||
    attempt.gateway_session_id !== transport.gateway.sessionId
  ) {
    return { kind: 'none' }
  }
  let ids: string[] = []
  try {
    ids = await transport.findSentMessages({
      to: attempt.to_phone,
      body: attempt.expected_body,
      since: Date.parse(attempt.first_sent_at),
      until: Date.parse(attempt.started_at ?? attempt.first_sent_at),
    })
  } catch (err) {
    // History unavailable: not evidence either way.
    console.warn('[broadcast-attempts] gateway history lookup failed:', err instanceof Error ? err.message : err)
    return { kind: 'none' }
  }
  if (ids.length === 0) return { kind: 'none' }
  const { data, error: settleErr } = await db.rpc('broadcast_attempt_settle_evidence', {
    p_account_id: accountId,
    p_attempt_id: attempt.id,
    p_message_ids: ids,
    p_source: 'history',
  })
  if (settleErr) throw new AttemptStoreError('reconcile (history)', settleErr)
  return settled(data)
}

/** OpenWA `message.sent`: does this echo prove an open attempt? */
export async function reconcileAttemptFromEcho(
  db: SupabaseClient,
  args: {
    accountId: string
    /** The number the echo came from: only its broadcasts' sends (migration 087). */
    connectionId: string
    toPhone: string
    body: string | null
    messageId: string
    sentAt: string
  },
): Promise<string | null> {
  if (!args.body) return null
  const { data, error } = await db.rpc('broadcast_attempt_reconcile_echo', {
    p_account_id: args.accountId,
    p_connection_id: args.connectionId,
    p_to_phone: args.toPhone,
    p_body: args.body,
    p_message_id: args.messageId,
    p_sent_at: args.sentAt,
  })
  if (error) throw new AttemptStoreError('reconcile (echo)', error)
  return typeof data === 'string' ? data : null
}

// ---------------------------------------------------------------
// One recipient, end to end
// ---------------------------------------------------------------

export type RecipientSendResult =
  | { status: 'sent'; messageId: string | null }
  | { status: 'failed'; error: string }
  /** Not attempted in this pass (budget, pacing, someone else's try). */
  | { status: 'deferred' }
  /** Left open for a later pass (in progress, resendable unknown, backoff). */
  | { status: 'pending'; retryAt: number }
  /** Outcome unknown and not safely resendable — a person decides. */
  | { status: 'unknown'; error: string }
  /** Nothing to do (already sent, or no longer pending). */
  | { status: 'skipped' }

export interface RecipientSendContext {
  accountId: string
  transport: WhatsAppTransport
  /** Waits out provider pacing; false = this pass is out of budget. */
  pace: () => Promise<boolean>
  /** Absolute deadline for the provider call (transports abort at it). */
  sendBy?: number
  now?: () => number
}

export interface RecipientSendOutcome {
  result: RecipientSendResult
  /** The pass should stop here (out of budget). */
  stop: boolean
}

export function toSendArgs(p: FrozenTemplateSend): SendTemplateArgs {
  return {
    to: p.to,
    templateName: p.templateName,
    language: p.language,
    template: p.template,
    params: p.params,
    ...(p.messageParams ? { messageParams: p.messageParams } : {}),
  }
}

export async function sendBroadcastRecipient(
  db: SupabaseClient,
  ctx: RecipientSendContext,
  recipientId: string,
  payload: FrozenTemplateSend,
): Promise<RecipientSendOutcome> {
  const now = ctx.now ?? Date.now
  const { accountId, transport } = ctx
  const done = (result: RecipientSendResult, stop = false): RecipientSendOutcome => ({ result, stop })

  // 1. The attempt: open one (same key + payload), or a new one.
  let attempt = await prepareAttempt(db, accountId, recipientId, transport, payload)
  if (!attempt) return done({ status: 'skipped' })
  if (attempt.needs_decision) return done({ status: 'unknown', error: attempt.error_message ?? 'Outcome unknown' })
  if (attempt.next_retry_at && Date.parse(attempt.next_retry_at) > now()) {
    return done({ status: 'pending', retryAt: Date.parse(attempt.next_retry_at) })
  }
  if (attempt.lease_until && Date.parse(attempt.lease_until) > now()) return done({ status: 'deferred' })

  // 2. Reached the provider before and its outcome is open — whatever
  //    the attempt's state says (K1): find out before sending again.
  if (attempt.first_sent_at) {
    const found = await reconcileAttempt(db, accountId, attempt, transport)
    if (found.kind === 'sent') return done({ status: 'sent', messageId: found.messageId })
    if (found.kind === 'ambiguous') {
      return done({ status: 'unknown', error: 'Ambiguous evidence — check the chat' })
    }
    if (!canResend(attempt, transport, now())) {
      const reason = 'Outcome unknown and not safely resendable (provider window, gateway or key) — check the chat'
      await holdAttempt(db, accountId, attempt, reason)
      return done({ status: 'unknown', error: reason })
    }
  }

  const frozen = attempt.payload
  const args: SendTemplateArgs = {
    ...toSendArgs(frozen),
    sendBy: ctx.sendBy,
    idempotencyKey: attempt.idempotency_key,
  }

  // 3. Slow, send-independent work (a media header to inline) BEFORE a
  //    paced slot is reserved. Nothing has been sent yet.
  try {
    await transport.prepareTemplate?.(args)
  } catch (err) {
    if (err instanceof SendBudgetExceededError) return done({ status: 'deferred' }, true)
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (attempt.first_sent_at) {
      // A resend whose media can't be prepared now: try again later.
      return done({ status: 'pending', retryAt: now() + UNKNOWN_RETRY_MS })
    }
    await finishAttempt(db, accountId, attempt, { kind: 'failed', code: 'prepare', message })
    return done({ status: 'failed', error: message })
  }

  // 4. Pacing, bounded by the budget.
  if (!(await ctx.pace())) return done({ status: 'deferred' }, true)

  // 5. The checkpoint. No claimed row — no send.
  const leaseUntil = (ctx.sendBy ?? now() + 60_000) + LEASE_SLACK_MS
  const claimed = await beginAttempt(db, accountId, attempt, transport, leaseUntil)
  if (!claimed) return done({ status: 'deferred' })
  attempt = claimed

  // 6. The external effect.
  try {
    const { result } = await sendWithRecipientVariants(transport, frozen.to, true, (to) =>
      transport.sendTemplate({ ...args, to }),
    )
    const state = await finishAttempt(db, accountId, attempt, { kind: 'sent', messageId: result.messageId })
    if (state === 'ambiguous') {
      // The provider's id already proves another attempt (K2): held.
      return done({ status: 'unknown', error: `Message ${result.messageId} already proves another send` })
    }
    return done({ status: 'sent', messageId: result.messageId })
  } catch (err) {
    if (err instanceof AttemptStoreError) throw err
    const outcome = classifySendError(transport, err)
    const budgetHit = ctx.sendBy !== undefined && now() >= ctx.sendBy - 1000
    switch (outcome.kind) {
      case 'failed':
        await finishAttempt(db, accountId, attempt, outcome)
        return done({ status: 'failed', error: outcome.message })
      case 'retry_later': {
        const retryAt = outcome.outOfBudget ? now() : now() + IN_PROGRESS_BACKOFF_MS
        await finishAttempt(db, accountId, attempt, { ...outcome, retryAt })
        return done({ status: 'pending', retryAt }, outcome.outOfBudget || budgetHit)
      }
      case 'in_progress': {
        const backoff = Math.min(IN_PROGRESS_BACKOFF_MS * 2 ** Math.max(0, attempt.tries - 1), IN_PROGRESS_BACKOFF_MAX_MS)
        const retryAt = now() + backoff
        await finishAttempt(db, accountId, attempt, { ...outcome, retryAt })
        return done({ status: 'pending', retryAt }, budgetHit)
      }
      case 'unknown': {
        const resendable = outcome.resendable && canResend(attempt, transport, now())
        const retryAt = now() + UNKNOWN_RETRY_MS
        await finishAttempt(db, accountId, attempt, {
          kind: 'unknown',
          code: outcome.code,
          message: resendable ? outcome.message : `Outcome unknown — check the chat (${outcome.message})`,
          retryAt,
          needsDecision: !resendable,
        })
        return resendable
          ? done({ status: 'pending', retryAt }, budgetHit)
          : done({ status: 'unknown', error: outcome.message }, budgetHit)
      }
    }
  }
}
