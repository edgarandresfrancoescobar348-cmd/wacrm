// ============================================================
// Inbound fan-out — the durable outbox of an inbound message's side
// effects (migration 057; third review H1).
//
// When ingestion completes a message it also enqueues ONE task for it,
// in the same transaction (complete_inbound_message). The task carries
// everything the fan-out needs, so it no longer depends on closures of
// the request that stored the message:
//
//   flows → a waiting automation → automation triggers → AI auto-reply
//   → the public `message.received` webhook
//
// Whoever processed the message runs its task right away (inline or in
// `after()`); a redelivery of the message and the cron (drain) run it
// when that didn't happen. A runner claims the task with a lease and
// records each step once it finished, so a re-run (lease expired, a
// failed attempt retried) resumes after the last recorded step and the
// steps already run are not repeated. A step interrupted by a crash
// before its record is the one window where it can run twice.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { resumeAwaitingReply, runAutomationsForTrigger } from '@/lib/automations/engine'
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
  /** False on the account's inactive connection: webhooks only. */
  botsEnabled: boolean
}

interface FanoutProgress {
  flows?: { consumed: boolean }
  awaiting?: { consumed: boolean }
  automations?: true
  ai?: true
  webhook?: true
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

export class FanoutStoreError extends Error {
  constructor(step: string, cause?: { message?: string } | null) {
    super(`inbound fan-out ${step} failed${cause?.message ? `: ${cause.message}` : ''}`)
    this.name = 'FanoutStoreError'
  }
}

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
async function writeTask(db: SupabaseClient, task: FanoutTask, patch: Record<string, unknown>, step: string) {
  const { data, error } = await db
    .from('inbound_fanout_tasks')
    .update(patch)
    .eq('id', task.id)
    .eq('attempts', task.attempts)
    .eq('status', 'running')
    .select('id')
  if (error) throw new FanoutStoreError(step, error)
  if (!Array.isArray(data) || data.length === 0) {
    // Our lease ran out and another runner took the task over.
    throw new FanoutStoreError(`${step} (lease lost)`)
  }
}

/** The steps, skipping those already in `progress`; `record` after each. */
async function runSteps(
  db: SupabaseClient,
  p: InboundFanoutPayload,
  progress: FanoutProgress,
  record: (step: string) => Promise<void>,
): Promise<void> {
  // Flows win over everything else: a flow that consumed the message
  // suppresses the content-level automation triggers and the AI reply.
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
      : { consumed: false }
    progress.flows = { consumed: r.consumed }
    await record('flows')
  }
  const flowConsumed = progress.flows.consumed

  // An automation parked at "wait for reply" takes this message.
  if (!progress.awaiting) {
    const consumed =
      flowConsumed || !p.botsEnabled
        ? false
        : await resumeAwaitingReply({
            accountId: p.accountId,
            contactId: p.contactId,
            context: {
              message_text: p.inboundText,
              conversation_id: p.conversationId,
              interactive_reply_id: p.interactiveReplyId ?? undefined,
            },
          })
    progress.awaiting = { consumed }
    await record('awaiting')
  }
  const contentConsumed = flowConsumed || progress.awaiting.consumed

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
    for (const triggerType of p.botsEnabled ? triggers : []) {
      await runAutomationsForTrigger({
        accountId: p.accountId,
        triggerType,
        contactId: p.contactId,
        context: {
          message_text: p.inboundText,
          conversation_id: p.conversationId,
          interactive_reply_id: p.interactiveReplyId ?? undefined,
        },
      }).catch((err) => console.error('[automations] dispatch failed:', err))
    }
    progress.automations = true
    await record('automations')
  }

  // AI auto-reply: plain text nobody else consumed.
  if (!progress.ai) {
    if (p.botsEnabled && !contentConsumed && !p.interactiveReplyId && p.inboundText.trim()) {
      await dispatchInboundToAiReply({
        accountId: p.accountId,
        conversationId: p.conversationId,
        contactId: p.contactId,
        configOwnerUserId: p.configOwnerUserId,
        inboundMessageId: p.providerMessageId,
      })
    }
    progress.ai = true
    await record('ai')
  }

  if (!progress.webhook) {
    await dispatchWebhookEvent(db, p.accountId, 'message.received', {
      conversation_id: p.conversationId,
      contact_id: p.contactId,
      whatsapp_message_id: p.providerMessageId,
      content_type: p.contentType,
      text: p.contentText,
    })
    progress.webhook = true
  }
}

/** Run one claimed task, step by step, recording each. */
export async function runFanoutTask(db: SupabaseClient, task: FanoutTask): Promise<void> {
  const progress: FanoutProgress = { ...(task.progress ?? {}) }
  try {
    await runSteps(db, task.payload, progress, (step) => writeTask(db, task, { progress }, `record ${step}`))
    await writeTask(db, task, { progress, status: 'done', done_at: new Date().toISOString(), lease_until: null, last_error: null }, 'finish')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[inbound fan-out] task ${task.id} failed:`, message)
    if (err instanceof FanoutStoreError && message.includes('lease lost')) return
    // Back off; the steps recorded so far are not run again.
    const backoffMs = Math.min(2 ** task.attempts * 60_000, 60 * 60_000)
    await writeTask(
      db,
      task,
      {
        progress,
        status: 'failed',
        lease_until: null,
        last_error: message.slice(0, 500),
        next_attempt_at: new Date(Date.now() + backoffMs).toISOString(),
      },
      'record failure',
    ).catch((e) => console.error('[inbound fan-out] could not record the failure:', e instanceof Error ? e.message : e))
  }
}

/**
 * Last resort for a caller that can't be redelivered (Meta's webhook is
 * acknowledged up front) when the completion — and with it the outbox
 * row — could not be written: run the steps in this request, as before
 * the outbox existed, rather than drop the bot reply.
 */
export async function runFanoutWithoutOutbox(db: SupabaseClient, payload: InboundFanoutPayload): Promise<void> {
  await runSteps(db, payload, {}, async () => undefined)
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

/** Cron safety net: run fan-out tasks nobody ran (or whose runner died). */
export async function drainInboundFanout(
  db: SupabaseClient,
  opts: { limit?: number; deadline?: number; now?: () => number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now
  const tasks = await claim(db, {
    messageId: null,
    limit: opts.limit ?? 20,
    minAgeSeconds: FANOUT_DRAIN_MIN_AGE_SECONDS,
  })
  let ran = 0
  for (const task of tasks) {
    if (opts.deadline !== undefined && now() >= opts.deadline) {
      // Out of time: hand it back for the next run.
      await writeTask(db, task, { status: 'pending', lease_until: null }, 'release').catch(() => undefined)
      continue
    }
    await runFanoutTask(db, task)
    ran++
  }
  return ran
}
