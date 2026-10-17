// ============================================================
// Inbound fan-out — the durable outbox of an inbound message's side
// effects (migration 057; third review H1, fourth review K3–K5).
//
// When ingestion completes a message it also enqueues ONE task for it,
// in the same transaction (complete_inbound_message). The task carries
// everything the fan-out needs, so it never depends on closures of the
// request that stored the message:
//
//   flows → a waiting automation → automation triggers → AI auto-reply
//   → the public `message.received` webhook
//
// Whoever processed the message runs its task right away (inline or in
// `after()`); a redelivery of the message and the cron (drain) run it
// when that didn't happen. A message whose completion itself could not
// be written is completed by the cron from its stored inputs (K5) — the
// fan-out never runs outside a claimed task.
//
// Ownership (K3): a runner claims the task with a lease; BEFORE each
// step it renews the lease and reloads the recorded progress in one
// conditional write. A runner that lost the task stops before the step;
// a step already recorded by anyone is never run again.
//
// Outcomes (K4): every step reports ok / noop / retry / uncertain
// (lib/effects.ts). ok/noop are recorded; retry leaves the step for a
// later attempt (backoff); uncertain HOLDS the task for a person —
// running it again could duplicate what may already have happened.
// The one remaining overlap: a single step that outlives the lease
// (5 min) while another runner takes the task over.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { EffectOutcome } from '@/lib/effects'
import { resumeAwaitingReplyOutcome, runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

/** Everything the fan-out of one inbound message needs. JSON-safe. */
export interface InboundFanoutPayload {
  accountId: string
  configOwnerUserId: string
  contactId: string
  conversationId: string
  /** Provider message id of the inbound message. */
  providerMessageId: string
  contentType: string
  contentText: string | null
  inboundText: string
  interactiveReplyId: string | null
  isFirstInboundMessage: boolean
  contactWasCreated: boolean
  /** False on a personal number (phase 6) and on imported history. */
  botsEnabled: boolean
  /** The number the message came in on (absent on tasks from before phase 6). */
  connectionId?: string
  /** A personal number's message: nothing runs, not even the public webhook. */
  personal?: boolean
  /** The conversation preview the completion writes (K5 repair). */
  lastMessageText?: string
}

interface WebhookProgress {
  deliveryId: string
  occurredAt: string
  /** Endpoints still to deliver to; null = all subscribed. */
  pending: string[] | null
  done?: boolean
}

interface FanoutProgress {
  flows?: { consumed: boolean }
  awaiting?: { consumed: boolean }
  automations?: true
  ai?: true
  webhook?: WebhookProgress
}

export interface FanoutTask {
  id: string
  message_id: string
  payload: InboundFanoutPayload
  attempts: number
  progress: FanoutProgress
}

/** How long a claimed task is held before another runner may take it. */
export const FANOUT_LEASE_SECONDS = 300
/** Pending tasks younger than this are left to the request running them. */
export const FANOUT_DRAIN_MIN_AGE_SECONDS = 60
/** Incomplete messages younger than this are left to their delivery. */
export const STALE_INBOUND_MIN_AGE_SECONDS = 120

export class FanoutStoreError extends Error {
  constructor(step: string, cause?: { message?: string } | null) {
    super(`inbound fan-out ${step} failed${cause?.message ? `: ${cause.message}` : ''}`)
    this.name = 'FanoutStoreError'
  }
}
class LeaseLostError extends Error {}
class StepRetry extends Error {}
class StepUncertain extends Error {}

async function claim(
  db: SupabaseClient,
  args: { messageId: string | null; limit: number; minAgeSeconds: number },
): Promise<FanoutTask[]> {
  const { data, error } = await db.rpc('claim_inbound_fanout', {
    p_message_id: args.messageId,
    p_limit: args.limit,
    p_min_age_seconds: args.minAgeSeconds,
    p_lease_seconds: FANOUT_LEASE_SECONDS,
  })
  if (error) throw new FanoutStoreError('claim', error)
  return (Array.isArray(data) ? data : []) as FanoutTask[]
}

/** Write the task row while we still hold it (lease token = attempts). */
async function writeTask(
  db: SupabaseClient,
  task: FanoutTask,
  patch: Record<string, unknown>,
  step: string,
): Promise<FanoutProgress> {
  const { data, error } = await db
    .from('inbound_fanout_tasks')
    .update(patch)
    .eq('id', task.id)
    .eq('attempts', task.attempts)
    .eq('status', 'running')
    .select('progress')
  if (error) throw new FanoutStoreError(step, error)
  if (!Array.isArray(data) || data.length === 0) throw new LeaseLostError(step)
  return ((data[0] as { progress?: FanoutProgress }).progress ?? {}) as FanoutProgress
}

/** Renew the lease and reload the recorded progress — before EVERY step. */
function ownStep(db: SupabaseClient, task: FanoutTask, step: string): Promise<FanoutProgress> {
  return writeTask(
    db,
    task,
    { lease_until: new Date(Date.now() + FANOUT_LEASE_SECONDS * 1000).toISOString() },
    `lease before ${step}`,
  )
}

function settle(step: string, effect: EffectOutcome | undefined): void {
  if (effect === 'retry') throw new StepRetry(step)
  if (effect === 'uncertain') throw new StepUncertain(step)
}

async function runSteps(db: SupabaseClient, task: FanoutTask): Promise<FanoutProgress> {
  const p = task.payload
  let progress: FanoutProgress = task.progress ?? {}
  const record = async (step: string, next: FanoutProgress) => {
    progress = await writeTask(db, task, { progress: next }, `record ${step}`)
  }

  // Flows win over everything else: a flow that consumed the message
  // suppresses the content-level automation triggers and the AI reply.
  progress = await ownStep(db, task, 'flows')
  if (!progress.flows) {
    const r = p.botsEnabled
      ? await dispatchInboundToFlows({
          accountId: p.accountId,
          userId: p.configOwnerUserId,
          contactId: p.contactId,
          conversationId: p.conversationId,
          message: p.interactiveReplyId
            ? {
                kind: 'interactive_reply',
                reply_id: p.interactiveReplyId,
                reply_title: p.contentText ?? '',
                meta_message_id: p.providerMessageId,
              }
            : { kind: 'text', text: p.contentText ?? p.inboundText, meta_message_id: p.providerMessageId },
          isFirstInboundMessage: p.isFirstInboundMessage,
        })
      : { consumed: false, effect: 'noop' as const }
    settle('flows', r.effect)
    await record('flows', { ...progress, flows: { consumed: r.consumed } })
  }
  const flowConsumed = progress.flows!.consumed

  // An automation parked at "wait for reply" takes this message.
  progress = await ownStep(db, task, 'awaiting')
  if (!progress.awaiting) {
    const r =
      flowConsumed || !p.botsEnabled
        ? { consumed: false, effect: 'noop' as const }
        : await resumeAwaitingReplyOutcome({
            accountId: p.accountId,
            contactId: p.contactId,
            context: {
              message_text: p.inboundText,
              conversation_id: p.conversationId,
              interactive_reply_id: p.interactiveReplyId ?? undefined,
            },
          })
    settle('awaiting', r.effect)
    await record('awaiting', { ...progress, awaiting: { consumed: r.consumed } })
  }
  const contentConsumed = flowConsumed || progress.awaiting!.consumed

  progress = await ownStep(db, task, 'automations')
  if (!progress.automations) {
    const triggers: (
      | 'new_contact_created'
      | 'first_inbound_message'
      | 'new_message_received'
      | 'keyword_match'
      | 'interactive_reply'
    )[] = []
    if (!contentConsumed) {
      triggers.push('new_message_received', 'keyword_match')
      if (p.interactiveReplyId) triggers.push('interactive_reply')
    }
    if (p.contactWasCreated) triggers.unshift('new_contact_created')
    if (p.isFirstInboundMessage) triggers.unshift('first_inbound_message')
    // All triggers are one step: a lookup failure before ANY automation
    // ran retries the step; a failure after one started holds the task.
    let anyRan = false
    for (const triggerType of p.botsEnabled ? triggers : []) {
      const effect = await runAutomationsForTrigger({
        accountId: p.accountId,
        triggerType,
        contactId: p.contactId,
        context: {
          message_text: p.inboundText,
          conversation_id: p.conversationId,
          interactive_reply_id: p.interactiveReplyId ?? undefined,
        },
      })
      if (effect === 'retry' && anyRan) throw new StepUncertain('automations')
      settle('automations', effect)
      if (effect === 'ok') anyRan = true
    }
    await record('automations', { ...progress, automations: true })
  }

  // AI auto-reply: plain text nobody else consumed.
  progress = await ownStep(db, task, 'ai')
  if (!progress.ai) {
    if (p.botsEnabled && !contentConsumed && !p.interactiveReplyId && p.inboundText.trim()) {
      const effect = await dispatchInboundToAiReply({
        accountId: p.accountId,
        conversationId: p.conversationId,
        contactId: p.contactId,
        configOwnerUserId: p.configOwnerUserId,
        inboundMessageId: p.providerMessageId,
      })
      settle('ai', effect)
    }
    await record('ai', { ...progress, ai: true })
  }

  // The public webhook: the SAME delivery (id) to the endpoints that
  // haven't taken it yet.
  progress = await ownStep(db, task, 'webhook')
  // A personal number's messages never leave for the account's endpoints:
  // they are its owner's alone (phase 6).
  if (!progress.webhook?.done && p.personal) {
    await record('webhook', {
      ...progress,
      webhook: { deliveryId: '', occurredAt: new Date().toISOString(), pending: null, done: true },
    })
  } else if (!progress.webhook?.done) {
    const prev = progress.webhook
    const r = await dispatchWebhookEvent(
      db,
      p.accountId,
      'message.received',
      {
        conversation_id: p.conversationId,
        contact_id: p.contactId,
        whatsapp_message_id: p.providerMessageId,
        content_type: p.contentType,
        text: p.contentText,
      },
      prev ? { deliveryId: prev.deliveryId, occurredAt: prev.occurredAt, ...(prev.pending ? { endpointIds: prev.pending } : {}) } : {},
    )
    const webhook: WebhookProgress = {
      deliveryId: r.deliveryId,
      occurredAt: r.occurredAt,
      pending: r.failedEndpointIds,
      done: r.effect === 'ok' || r.effect === 'noop',
    }
    await record('webhook', { ...progress, webhook })
    settle('webhook', r.effect)
  }
  return progress
}

/** Run one claimed task, step by step. */
export async function runFanoutTask(db: SupabaseClient, task: FanoutTask): Promise<void> {
  try {
    const progress = await runSteps(db, task)
    await writeTask(
      db,
      task,
      { progress, status: 'done', done_at: new Date().toISOString(), lease_until: null, last_error: null },
      'finish',
    )
  } catch (err) {
    if (err instanceof LeaseLostError) {
      // Another runner owns the task now; nothing more from us.
      console.warn(`[inbound fan-out] task ${task.id}: lease lost (${err.message}) — stopping`)
      return
    }
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    const patch: Record<string, unknown> =
      err instanceof StepUncertain
        ? // A person decides: running it again could duplicate an effect.
          { status: 'held', lease_until: null, last_error: `uncertain outcome at step ${err.message}` }
        : {
            status: 'failed',
            lease_until: null,
            last_error: message.slice(0, 500),
            next_attempt_at: new Date(Date.now() + Math.min(2 ** task.attempts * 60_000, 60 * 60_000)).toISOString(),
          }
    console.error(`[inbound fan-out] task ${task.id}:`, patch.last_error)
    await writeTask(db, task, patch, 'record outcome').catch((e) =>
      console.error('[inbound fan-out] could not record the outcome:', e instanceof Error ? e.message : e),
    )
  }
}

/**
 * Run the fan-out of one message if it is due (not done, not held by
 * another runner). Safe to call from every path that touched the
 * message — the claim decides who runs it.
 */
export async function runFanoutForMessage(db: SupabaseClient, messageId: string): Promise<void> {
  const tasks = await claim(db, { messageId, limit: 1, minAgeSeconds: 0 })
  for (const task of tasks) await runFanoutTask(db, task)
}

/**
 * Cron safety net: complete inbound messages whose completion was never
 * written (K5), then run fan-out tasks nobody ran (or whose runner died).
 * Claims ONE task at a time, right before running it (K3).
 */
export async function drainInboundFanout(
  db: SupabaseClient,
  opts: { limit?: number; deadline?: number; now?: () => number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now
  const { error: staleErr } = await db.rpc('complete_stale_inbound_messages', {
    p_limit: opts.limit ?? 20,
    p_min_age_seconds: STALE_INBOUND_MIN_AGE_SECONDS,
  })
  if (staleErr) console.error('[inbound fan-out] completing stale messages failed:', staleErr.message)

  let ran = 0
  for (let i = 0; i < (opts.limit ?? 20); i++) {
    if (opts.deadline !== undefined && now() >= opts.deadline) break
    const [task] = await claim(db, { messageId: null, limit: 1, minAgeSeconds: FANOUT_DRAIN_MIN_AGE_SECONDS })
    if (!task) break
    await runFanoutTask(db, task)
    ran++
  }
  return ran
}
