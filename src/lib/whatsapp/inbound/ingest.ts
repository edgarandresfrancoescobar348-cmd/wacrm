// ============================================================
// Inbound ingestion — the single path every WhatsApp delivery takes
// into the CRM, whichever provider it came from.
//
// The provider webhooks (`/api/whatsapp/webhook` for Meta,
// `/api/whatsapp/openwa/webhook` for OpenWA) verify their delivery,
// translate it into an `InboundMessage` / `InboundStatusUpdate` and
// hand it here. Everything after that is shared: contact + conversation
// resolution, the idempotent message insert, unread bump, reopen,
// broadcast reply/status mirroring, Flows, automations, the AI
// auto-reply and the public webhook fan-out.
//
// Extracted unchanged from the Meta webhook route, whose test-suite
// still exercises it end to end.
// ============================================================

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  hasUsableIdentity,
  identityDisplayName,
  type WaIdentity,
} from '@/lib/whatsapp/wa-identity'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { resumeAwaitingReply, runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import type { WhatsAppProvider } from '@/lib/whatsapp/transport/types'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { matchNumberedMenuReply } from './numbered-menu'

export interface InboundContent {
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}

export interface InboundReaction {
  /** Provider id of the message reacted to. */
  targetMessageId: string
  /** '' = reaction removed. */
  emoji: string
}

export interface InboundMessage {
  provider: WhatsAppProvider
  /** Provider message id — the idempotency key, with the conversation. */
  messageId: string
  /** Unix seconds, as a string (Meta's wire format). */
  timestamp: string
  /**
   * Meta's type vocabulary: text, image, video, document, audio,
   * sticker, location, reaction, interactive, button, … Anything else
   * is stored as text.
   */
  type: string
  identity: WaIdentity
  /** Provider id of the quoted message, when it is a reply. */
  contextMessageId?: string | null
  /** Set when `type === 'reaction'`. */
  reaction?: InboundReaction | null
  /** Raw text body, if any — fallback for the automation context. */
  text?: string | null
  /**
   * Provider-specific content resolution (media verification and
   * mirroring, interactive reply ids). Not called for reactions.
   */
  resolveContent: (ctx: { accountId: string }) => Promise<InboundContent>
}

export interface IngestOptions {
  /**
   * False when the delivery came in on the account's inactive
   * connection: store it, bump unread, fan out webhooks — but no flow,
   * automation or AI reply runs for it.
   */
  runBots?: boolean
  /** Map typed replies to the last numbered menu we sent (QR mode). */
  mapNumberedMenuReplies?: boolean
  /**
   * Called once when this delivery created the contact — lets a
   * provider enrich it (OpenWA: profile picture). Best-effort; errors
   * are logged, never thrown.
   */
  onContactCreated?: (contact: { id: string }) => Promise<void>
  /**
   * Throw {@link IngestFailure} instead of logging-and-returning when a
   * write the message depends on fails (contact, conversation, message
   * insert). A webhook that can still answer non-2xx uses this so the
   * provider redelivers; the idempotent insert makes the retry safe.
   */
  throwOnFailure?: boolean
  /**
   * Hand the bot fan-out (flows, automations, AI, public webhooks) to the
   * caller instead of running it inline — it runs after the durable part
   * succeeded, e.g. in `after()` once the delivery has been acknowledged.
   */
  deferFanOut?: (task: () => Promise<void>) => void
}

/** A transient failure the provider should retry (see throwOnFailure). */
export class IngestFailure extends Error {
  constructor(step: string, cause?: unknown) {
    super(
      `ingestion failed at ${step}` +
        (cause && typeof cause === 'object' && 'message' in cause
          ? `: ${(cause as { message: string }).message}`
          : '')
    )
    this.name = 'IngestFailure'
  }
}

/** Why an outbound message failed, provider-neutral. */
export interface InboundStatusFailure {
  code: number
  title: string
  details: string | null
}

export interface InboundStatusUpdate {
  /** Provider message id of OUR outbound message. */
  id: string
  /** sent | delivered | read | failed */
  status: string
  /** Unix seconds, as a string. */
  timestamp: string
  failure?: InboundStatusFailure | null
}

export interface StatusScope {
  /** Throw {@link IngestFailure} on a DB error instead of logging it. */
  throwOnFailure?: boolean
  /**
   * Restrict every read and write to this account's rows. The Meta
   * webhook has always matched globally on the wamid; the OpenWA
   * webhook scopes to the session's account, since its ids are only
   * unique per number.
   */
  accountId?: string
}

async function updateAccountMessages(
  accountId: string,
  providerMessageId: string,
  update: Record<string, unknown>,
  /** Extra PostgREST `or` filter the update is conditional on. */
  onlyIf?: string
): Promise<{ error: { message: string } | null }> {
  const { data: rows, error } = await supabaseAdmin()
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', providerMessageId)
    .eq('conversations.account_id', accountId)
  if (error) return { error }
  const ids = (rows ?? []).map((r: { id: string }) => r.id)
  if (ids.length === 0) return { error: null }
  let q = supabaseAdmin().from('messages').update(update).in('id', ids)
  if (onlyIf) q = q.or(onlyIf)
  const { error: updErr } = await q
  return { error: updErr }
}

/** Match the reply against the menu it quotes, if it quotes one of ours. */
async function mapReplyToQuotedMenu(
  quotedInternalId: string,
  text: string
): Promise<{ id: string; title: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('sender_type, content_type, interactive_payload')
    .eq('id', quotedInternalId)
    .maybeSingle()
  if (error || !data) return null
  if (data.content_type !== 'interactive' || !['agent', 'bot'].includes(String(data.sender_type))) {
    return null
  }
  const payload = data.interactive_payload as InteractiveMessagePayload | null
  return payload ? matchNumberedMenuReply(payload, text) : null
}

/**
 * Match the customer's typed reply against the last message WE sent in
 * the conversation, when that message is an interactive menu.
 */
async function mapReplyToLastMenu(
  conversationId: string,
  text: string
): Promise<{ id: string; title: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('content_type, interactive_payload')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data || data.content_type !== 'interactive') return null
  const payload = data.interactive_payload as InteractiveMessagePayload | null
  if (!payload) return null
  return matchNumberedMenuReply(payload, text)
}

// The status ladder (pending → sent → delivered → read → replied, with
// `failed` only from pending/sending/sent) lives in SQL since migration
// 052: public._wa_status_advances, used by apply_message_receipt and the
// row-creation triggers, so every writer applies it atomically.

export async function applyStatusUpdate(
  status: InboundStatusUpdate,
  scope: StatusScope = {}
) {
  // Meta's reason for a failed send (#535). Only read on `failed`; a
  // later non-failed status for the same wamid leaves the error
  // columns alone rather than clearing them, so the reason survives.
  const failure = status.status === 'failed' ? (status.failure ?? null) : null

  if (failure) {
    console.warn(
      `WhatsApp message ${status.id} failed: [${failure.code}] ${failure.title}` +
        (failure.details ? ` — ${failure.details}` : '')
    )
  }

  // 1+2) One atomic, monotonic database operation (migration 052):
  //    retains the receipt per destination in message_status_pending,
  //    and advances every matching messages / broadcast_recipients row
  //    with the pending → sent → delivered → read ladder in the UPDATE
  //    itself — under an advisory lock shared with the row-creation
  //    triggers, so a receipt racing the sender's insert, a second
  //    concurrent receipt, or a recipient stamped later all converge.
  //    The aggregate trigger on broadcast_recipients re-derives the
  //    parent broadcast's counts. Scope: the account for OpenWA, global
  //    for Meta wamids (as before).
  const { error: receiptErr } = await supabaseAdmin().rpc('apply_message_receipt', {
    p_account: scope.accountId ?? null,
    p_provider_message_id: status.id,
    p_status: status.status,
    p_failure: failure,
    p_status_at: new Date(parseInt(status.timestamp) * 1000).toISOString(),
  })
  if (receiptErr) {
    console.error('Error applying message receipt:', receiptErr)
    if (scope.throwOnFailure) throw new IngestFailure('message receipt', receiptErr)
  }
  if (Math.random() < 0.01) {
    // Opportunistic expiry of retained receipts (~3 days). Best-effort.
    try {
      await supabaseAdmin()
        .from('message_status_pending')
        .delete()
        .lt('created_at', new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString())
    } catch (err) {
      console.warn('[webhook] pending receipt cleanup failed:', err)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = scope.accountId
    ? await supabaseAdmin()
        .from('messages')
        .select('conversation_id, conversations!inner(account_id)')
        .eq('message_id', status.id)
        .eq('conversations.account_id', scope.accountId)
        .limit(1)
        .maybeSingle()
    : await supabaseAdmin()
        .from('messages')
        .select('conversation_id, conversations(account_id)')
        .eq('message_id', status.id)
        .limit(1)
        .maybeSingle()

  if (msgRow) {
    // A to-one embed; typed as an array by the generic client.
    const conv = msgRow.conversations as unknown as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a provider-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByProviderId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  reaction: InboundReaction | null | undefined,
  conversationId: string,
  contactId: string,
  throwOnFailure = false
) {
  if (!reaction?.targetMessageId) return

  const targetInternalId = await lookupInternalIdByProviderId(
    reaction.targetMessageId,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.targetMessageId
    )
    return
  }

  // Empty emoji = removal (Meta's Cloud API spec; OpenWA is mapped to it).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
      if (throwOnFailure) throw new IngestFailure('reaction delete', delError)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
    if (throwOnFailure) throw new IngestFailure('reaction upsert', upsertError)
  }
}

export async function ingestInboundMessage(
  inbound: InboundMessage,
  // Tenancy. Resolved from the matched config row; every contact /
  // conversation / message row created downstream is stamped with this
  // so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  options: IngestOptions = {}
) {
  // Phone number OR business-scoped user ID — Meta sends only the
  // latter for a sender who has adopted a WhatsApp username (#519).
  const identity = inbound.identity
  if (!hasUsableIdentity(identity)) {
    // Neither key present. Creating a row anyway would mean an
    // unreachable contact that can never be matched again, so drop the
    // delivery loudly instead of silently accumulating them.
    console.error(
      '[webhook] inbound message carries neither a phone number nor a BSUID; skipping:',
      inbound.messageId
    )
    return
  }

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    identity
  )
  if (!contactOutcome) {
    if (options.throwOnFailure) throw new IngestFailure('contact')
    return
  }
  const contactRecord = contactOutcome.contact
  if (contactOutcome.wasCreated && options.onContactCreated) {
    try {
      await options.onContactCreated(contactRecord)
    } catch (err) {
      console.warn('[webhook] onContactCreated hook failed:', err)
    }
  }

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) {
    if (options.throwOnFailure) throw new IngestFailure('conversation')
    return
  }
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (inbound.type === 'reaction') {
    await handleReaction(inbound.reaction, conversation.id, contactRecord.id, options.throwOnFailure)
    return
  }

  // Parse message content based on type
  // Provider-specific: media verification + mirroring, type mapping.
  const parsed = await inbound.resolveContent({ accountId })
  const { mediaUrl, mediaType } = parsed
  let { contentText, interactiveReplyId } = parsed

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (inbound.contextMessageId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      inbound.contextMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        inbound.contextMessageId
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, media_type, template_name, message_id, status,
  //   created_at

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  let contentType = ALLOWED_CONTENT_TYPES.has(inbound.type)
    ? inbound.type
    : inbound.type === 'sticker'
      ? 'image'         // stickers are images
      : inbound.type === 'button'
        ? 'interactive' // template quick-reply tap (issue #478)
        : 'text'        // reaction, unknown → text fallback

  // Numbered-menu fallback (providers without native buttons/lists):
  // the customer answered our last interactive prompt by typing an
  // option number or title. Map it back to that option's id so Flows,
  // waiting automations and the interactive_reply trigger see exactly
  // what a native tap would have produced.
  if (
    options.mapNumberedMenuReplies &&
    contentType === 'text' &&
    !interactiveReplyId &&
    contentText
  ) {
    // A swipe-reply names its menu: map ONLY against the quoted message
    // (and leave the text alone if that isn't one of our menus). Without
    // a quote, the conversation's latest outbound message is the prompt.
    const mapped = inbound.contextMessageId
      ? replyToInternalId
        ? await mapReplyToQuotedMenu(replyToInternalId, contentText)
        : null
      : await mapReplyToLastMenu(conversation.id, contentText)
    if (mapped) {
      contentType = 'interactive'
      contentText = mapped.title
      interactiveReplyId = mapped.id
    }
  }

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')

  // Idempotent insert. Meta retries webhook deliveries (a slow ack, a
  // transient 5xx), and each retry replays the exact same message.id. The
  // unique index on (conversation_id, message_id) added in migration 037
  // makes a replay conflict; `ignoreDuplicates` turns that into an ON
  // CONFLICT DO NOTHING, and the `.select()` then returns the inserted row
  // ONLY on a genuine first insert — an empty result means this delivery
  // was a replay. This is the single idempotency boundary that must sit
  // BEFORE the unread bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        // Meta's MIME type for the attachment (migration 039). Was
        // discarded before, which forced the download path to guess an
        // extension from the fetched blob — impossible to do until the
        // bytes had already been fetched successfully.
        media_type: mediaType,
        message_id: inbound.messageId,
        status: 'delivered',
        created_at: new Date(parseInt(inbound.timestamp) * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        // Only populated for content_type='interactive'. Migration 010 added
        // the column; null for every other content_type so existing inserts
        // behave identically.
        interactive_reply_id: interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')

  if (msgError) {
    console.error('Error inserting message:', msgError)
    if (options.throwOnFailure) throw new IngestFailure('message insert', msgError)
    return
  }

  // Replayed delivery: the message already exists. If its processing
  // COMPLETED (migration 053's ingest_completed_at), acknowledge it as a
  // no-op — that is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling and
  // re-dispatching public webhooks (issue #367). If it did NOT complete
  // (a step after the insert failed, or the worker died), this delivery
  // repairs it: the remaining steps are idempotent and completion is
  // claimed atomically below, so they run exactly once.
  let messageRowId: string
  let repairing = false
  if (!insertedRows || insertedRows.length === 0) {
    const { data: existing, error: existingErr } = await supabaseAdmin()
      .from('messages')
      .select('id, ingest_completed_at')
      .eq('conversation_id', conversation.id)
      .eq('message_id', inbound.messageId)
      .maybeSingle()
    if (existingErr && options.throwOnFailure) {
      throw new IngestFailure('replay lookup', existingErr)
    }
    if (!existing || existing.ingest_completed_at) {
      console.info(
        '[webhook] duplicate inbound message ignored (idempotent replay):',
        inbound.messageId
      )
      return
    }
    console.info('[webhook] completing an interrupted inbound message:', inbound.messageId)
    messageRowId = existing.id
    repairing = true
  } else {
    messageRowId = insertedRows[0].id
  }
  // The pre-insert count included nothing; on a repair it includes the
  // message itself.
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) - (repairing ? 1 : 0) === 0

  // A customer writing again re-opens the thread (issue #409). Kept as a
  // separate conditional statement gated on the row's CURRENT status in
  // SQL — see the helper. Idempotent, so it runs before completion.
  await reopenClosedConversation(supabaseAdmin(), conversation, {
    throwOnError: options.throwOnFailure,
  })

  // Update conversation + mark the message complete, atomically and only
  // once (migration 053's 3-argument bump_conversation_on_inbound). The
  // unread bump stays DB-side rather than a read-modify-write of the
  // snapshot loaded above (issue #369). A failure here leaves the message
  // incomplete, so a redelivery repairs it.
  const { data: completedNow, error: convError } = await supabaseAdmin().rpc(
    'bump_conversation_on_inbound',
    {
      p_conversation_id: conversation.id,
      p_last_message_text: contentText || `[${inbound.type}]`,
      p_message_id: messageRowId,
    }
  )

  if (convError) {
    console.error('Error updating conversation:', convError)
    if (options.throwOnFailure) throw new IngestFailure('conversation summary', convError)
  }
  // Another delivery of the same message completed it concurrently —
  // its fan-out is the one that runs.
  if (completedNow === false) return

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003). Best-effort analytics, after
  // completion — never repeated by a redelivery.
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // Everything below is fan-out to bots and subscribers. It runs after
  // the durable part above; a caller may defer it (deferFanOut).
  const fanOut = async () => {
    // ============================================================
    // Flow runner dispatch.
    //
    // If the runner consumes the message (it either advanced an active
    // run or started a new one), we suppress the `new_message_received`
    // + `keyword_match` automation triggers for this inbound. Customer
    // is navigating the bot menu, not sending a fresh trigger word
    // that should fork into automations.
    //
    // The relationship-level triggers (`new_contact_created`,
    // `first_inbound_message`) still fire even when consumed — those
    // are about WHO is messaging, not what they said.
    //
    // Awaited (not fire-and-forget) because we need the `consumed`
    // result before deciding whether to dispatch automations. The
    // runner has its own try/catch and never throws. Accounts with
    // no active flows take the runner's early-exit "no_match" path
    // basically for free (one indexed SELECT for the active run).
    // ============================================================
    // A message that arrived on the account's INACTIVE connection (the
    // number it switched away from) is stored and surfaced, but no bot
    // answers it: the reply would go out from the other number.
    const botsEnabled = options.runBots !== false
    const flowResult = botsEnabled
      ? await dispatchInboundToFlows({
      accountId,
      userId: configOwnerUserId,
      contactId: contactRecord.id,
      conversationId: conversation.id,
      message:
        interactiveReplyId
          ? {
              kind: 'interactive_reply',
              reply_id: interactiveReplyId,
              reply_title: contentText ?? '',
              meta_message_id: inbound.messageId,
            }
          : {
              kind: 'text',
              text: contentText ?? inbound.text ?? '',
              meta_message_id: inbound.messageId,
            },
      isFirstInboundMessage,
    })
      : { consumed: false }
    const flowConsumed = flowResult.consumed

    // Fire any automations that react to this webhook event. All dispatches
    // run here (not earlier) so the contact, conversation, and inbound
    // message all exist before any step — including send_message — runs.
    // Fire-and-forget: a slow or failing automation must not block the
    // webhook's 200 OK response to Meta.
    const inboundText = contentText ?? inbound.text ?? ''

    // An automation parked at a "wait for reply" Send Buttons / Send List
    // step takes this message as its reply — a tap or typed text — and
    // continues from the step after the send. Like a Flow consuming the
    // message, that suppresses the content-level triggers and AI reply
    // below so the customer doesn't get a second bot answering. Runs
    // BEFORE the trigger dispatch so the message that parks a run can
    // never also resume it. Flows still win: only checked if no flow
    // consumed the message. Never throws.
    const automationConsumed = flowConsumed || !botsEnabled
      ? false
      : await resumeAwaitingReply({
          accountId,
          contactId: contactRecord.id,
          context: {
            message_text: inboundText,
            conversation_id: conversation.id,
            interactive_reply_id: interactiveReplyId ?? undefined,
          },
        })
    const contentConsumed = flowConsumed || automationConsumed

    const automationTriggers: (
      | 'new_contact_created'
      | 'first_inbound_message'
      | 'new_message_received'
      | 'keyword_match'
      | 'interactive_reply'
    )[] = []
    // Content-level triggers are suppressed when a flow or a waiting
    // automation consumed the message — see the comment blocks above.
    if (!contentConsumed) {
      automationTriggers.push('new_message_received', 'keyword_match')
      // Interactive tap → fire the interactive_reply trigger too (only
      // meaningful when a button/list reply actually arrived). Enables
      // automation-only chained menus; when a Flow owns the menu it will
      // have consumed the reply and this is skipped.
      if (interactiveReplyId) {
        automationTriggers.push('interactive_reply')
      }
    }
    // new_contact_created fires only when the webhook just auto-created the
    // contact row. first_inbound_message fires whenever this is the contact's
    // first-ever customer-sent message — a superset that also catches
    // manually-imported contacts sending for the first time. We dispatch both
    // so users can pick whichever semantic they want; an automation that
    // listens to only one trigger runs only when that trigger matches.
    if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
    if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
    // Awaited — not fire-and-forget. We're inside the route's `after()`
    // block, which only keeps the function alive for promises it can see, so
    // a detached dispatch can be frozen part-way through: the log row is
    // inserted, then the steps never run. That is issue #301's failure mode
    // recurring one level down, and it's what issue #409 reported as runs
    // logging zero steps. `runAutomationsForTrigger` owns its own try/catch
    // and never throws; the `.catch` is belt-and-braces so one trigger
    // type's failure can't skip the rest of the loop.
    for (const triggerType of botsEnabled ? automationTriggers : []) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contactRecord.id,
        context: {
          message_text: inboundText,
          conversation_id: conversation.id,
          // Only set on interactive taps; drives the interactive_reply
          // trigger's exact-id match.
          interactive_reply_id: interactiveReplyId ?? undefined,
        },
      }).catch((err) => console.error('[automations] dispatch failed:', err))
    }

    // AI auto-reply. Runs only for plain-text inbound the deterministic
    // flow runner did NOT consume (flows win over the LLM), and only when
    // the account has enabled it. Awaited inside `after()` (same reason as
    // the webhook dispatch below); `dispatchInboundToAiReply` owns its
    // eligibility gates + try/catch and never throws.
    if (botsEnabled && !contentConsumed && !interactiveReplyId && inboundText.trim()) {
      await dispatchInboundToAiReply({
        accountId,
        conversationId: conversation.id,
        contactId: contactRecord.id,
        configOwnerUserId,
        // Lets the bot show "typing…" (and mark the message read) while
        // the reply is generated.
        inboundMessageId: inbound.messageId,
      })
    }

    // message.received webhook (public API). Awaited — not fire-and-forget
    // — because we're inside the route's `after()` block, which only keeps
    // the function alive for promises it can see; a detached promise could
    // be frozen before it delivers. `dispatchWebhookEvent` early-exits
    // when the account has no matching endpoint and never throws.
    // (conversation.created is emitted earlier, right after the thread is
    // opened.)
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
      whatsapp_message_id: inbound.messageId,
      content_type: contentType,
      text: contentText,
    })
  }
  if (options.deferFanOut) options.deferFanOut(fanOut)
  else await fanOut()
}

/**
 * A message the business sent from outside wacrm (typed on the paired
 * phone itself — OpenWA's `message.sent`). Recorded as an agent message
 * so the CRM timeline matches the phone. Our own API sends come back
 * through the same event; the (conversation_id, message_id) unique
 * index turns those into no-ops. Never runs bots, never bumps unread.
 */
export async function recordOutboundEcho(
  echo: Omit<InboundMessage, 'reaction'>,
  accountId: string,
  configOwnerUserId: string,
  options: { throwOnFailure?: boolean } = {}
): Promise<'recorded' | 'duplicate' | 'skipped'> {
  const fail = (step: string, cause?: unknown): 'skipped' => {
    if (options.throwOnFailure) throw new IngestFailure(step, cause)
    return 'skipped'
  }
  if (!hasUsableIdentity(echo.identity)) return 'skipped'
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    // The recipient's profile name is not in an outbound echo — never
    // let it rename the contact.
    { ...echo.identity, name: '' }
  )
  if (!contactOutcome) return fail('contact')
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactOutcome.contact.id
  )
  if (!convResult) return fail('conversation')
  const conversationId = convResult.conversation.id

  const { data: existing } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', echo.messageId)
    .maybeSingle()
  if (existing) return 'duplicate'

  const { contentText, mediaUrl, mediaType } = await echo.resolveContent({ accountId })
  const ALLOWED = new Set(['text', 'image', 'document', 'audio', 'video', 'location'])
  const contentType = ALLOWED.has(echo.type)
    ? echo.type
    : echo.type === 'sticker'
      ? 'image'
      : 'text'

  let replyTo: string | null = null
  if (echo.contextMessageId) {
    replyTo = await lookupInternalIdByProviderId(echo.contextMessageId, conversationId)
  }

  const { data: inserted, error } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        conversation_id: conversationId,
        sender_type: 'agent',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        media_type: mediaType,
        message_id: echo.messageId,
        status: 'sent',
        created_at: new Date(parseInt(echo.timestamp) * 1000).toISOString(),
        reply_to_message_id: replyTo,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id')
  if (error) {
    console.error('[webhook] outbound echo insert failed:', error.message)
    return fail('echo insert', error)
  }
  if (!inserted || inserted.length === 0) return 'duplicate'

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${echo.type}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .eq('account_id', accountId)
  return 'recorded'
}

/**
 * Mark one of the account's messages as deleted-for-everyone or edited
 * by the customer. Account-scoped; the original text is kept on revoke.
 */
export async function applyMessageMutation(
  accountId: string,
  providerMessageId: string,
  mutation: { kind: 'revoked'; at: string } | { kind: 'edited'; at: string; text: string },
  options: { throwOnFailure?: boolean } = {}
): Promise<void> {
  const update: Record<string, unknown> =
    mutation.kind === 'revoked'
      ? { revoked_at: mutation.at }
      : { edited_at: mutation.at, content_text: mutation.text }
  // Edits are newest-wins: an older edit (redelivered late, replayed)
  // never overwrites a newer text.
  const { error } = await updateAccountMessages(
    accountId,
    providerMessageId,
    update,
    mutation.kind === 'edited' ? `edited_at.is.null,edited_at.lt.${mutation.at}` : undefined
  )
  if (error) {
    console.error(`[webhook] message ${mutation.kind} update failed:`, error.message)
    if (options.throwOnFailure) throw new IngestFailure(`message ${mutation.kind}`, error)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

/**
 * Look a contact up by BSUID. Exact match on the column backing
 * migration 040's unique index — no fuzzy matching, because a BSUID is
 * an opaque identifier with exactly one correct spelling.
 */
async function findContactByWaUserId(
  accountId: string,
  waUserId: string
): Promise<ContactRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle()

  if (error) {
    console.error('[webhook] BSUID contact lookup failed:', error.message)
    return null
  }
  return data ?? null
}

/**
 * Fields worth writing back onto a contact we just matched, given what
 * this delivery told us. Returns null when nothing changed, so the
 * common case costs no UPDATE.
 *
 * The BSUID backfill is the important one: it stamps the id onto a
 * contact we have only ever known by phone, so the NEXT message from
 * that person — which may well arrive with no phone number at all —
 * still resolves to this same row instead of forking a new one.
 * Likewise a phone backfill upgrades a BSUID-only contact the moment
 * Meta discloses the number, making them reachable by every existing
 * phone-based code path.
 */
function contactIdentityPatch(
  existing: ContactRow,
  identity: WaIdentity
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  // Only ever from a label Meta actually supplied. `identityDisplayName`
  // falls back to the phone number / BSUID, which is the right choice
  // for a brand-new row but would clobber an agent's hand-edited name
  // on every inbound message from a contact with no WhatsApp profile
  // name.
  const name = identity.name || identity.waUsername
  if (name && name !== existing.name) patch.name = name

  if (identity.waUserId && identity.waUserId !== existing.wa_user_id) {
    patch.wa_user_id = identity.waUserId
  }
  if (
    identity.waParentUserId &&
    identity.waParentUserId !== existing.wa_parent_user_id
  ) {
    patch.wa_parent_user_id = identity.waParentUserId
  }
  if (identity.waUsername && identity.waUsername !== existing.wa_username) {
    patch.wa_username = identity.waUsername
  }
  // Only ever fills a blank. An existing number is left alone — the
  // send path's variant retry already owns correcting it, and Meta's
  // formatting differences are not a reason to rewrite it.
  if (identity.phone && !normalizePhone(existing.phone ?? '')) {
    patch.phone = identity.phone
  }

  return Object.keys(patch).length > 0 ? patch : null
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  identity: WaIdentity
): Promise<ContactOutcome | null> {
  // BSUID first when we have one. It's stable per (user, business
  // portfolio) and, unlike the phone number, Meta will keep sending it
  // — so it's the key that survives a customer adopting a username.
  let existingContact: ContactRow | null = identity.waUserId
    ? await findContactByWaUserId(accountId, identity.waUserId)
    : null

  // Fall back to the phone. The shared helper pre-filters in SQL by the
  // last-8-digit suffix (so we don't pull every contact on every
  // inbound message) then applies the strict `phonesMatch` in JS on the
  // small candidate set. The same helper backs the manual contact form
  // and CSV import, so all three paths agree on what "same number"
  // means (issue #212).
  if (!existingContact && identity.phone) {
    existingContact = await findExistingContact(
      supabaseAdmin(),
      accountId,
      identity.phone,
    )
  }

  if (existingContact) {
    const patch = contactIdentityPatch(existingContact, identity)
    if (patch) {
      const { data: updated, error: updateError } = await supabaseAdmin()
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
        .select()
        .maybeSingle()

      if (updateError) {
        // A BSUID backfill can lose a race with a concurrent delivery
        // that already claimed it for another row. Not fatal — the
        // message still belongs to the contact we matched.
        console.error(
          '[webhook] contact identity backfill failed:',
          updateError.message
        )
      } else if (updated) {
        existingContact = updated
      }
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  //
  // `phone` stays NOT NULL in the schema, so a BSUID-only sender is
  // stored with '' — which migration 022's partial unique index
  // tolerates, and migration 040's BSUID index is what keeps them
  // unique instead.
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: identity.phone,
      name: identityDisplayName(identity),
      wa_user_id: identity.waUserId,
      wa_parent_user_id: identity.waParentUserId,
      wa_username: identity.waUsername,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and a unique
    // index (022's phone, or 040's BSUID) rejected the duplicate.
    // Re-resolve the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = identity.waUserId
        ? await findContactByWaUserId(accountId, identity.waUserId)
        : null
      if (raced) return { contact: raced, wasCreated: false }
      if (identity.phone) {
        const racedByPhone = await findExistingContact(
          supabaseAdmin(),
          accountId,
          identity.phone
        )
        if (racedByPhone) return { contact: racedByPhone, wasCreated: false }
      }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
