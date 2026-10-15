import type {
  InteractiveButton,
  InteractiveListSection,
  InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { assertConversationInAccount } from '@/lib/whatsapp/conversation-scope'
import {
  loadAccountTransport,
  sendWithRecipientVariants,
  TransportNotConfiguredError,
  type MediaKind,
  type WhatsAppTransport,
} from '@/lib/whatsapp/transport'
import { supabaseAdmin } from './admin-client'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ------------------------------------------------------------
// Engine-side WhatsApp senders (text, media, interactive).
//
// Used by the Flows runner, the automation engine (interactive sends
// delegate here) and the AI auto-reply. Every send goes through the
// account's active transport (`@/lib/whatsapp/transport` — Meta Cloud
// API or OpenWA), so none of these functions know which provider is on
// the other end. The shared part — account-scoped contact +
// conversation checks, the recipient-variant retry, the contact phone
// auto-fix — lives in `sendToContact`.
// ------------------------------------------------------------

/**
 * Resolve the account's active WhatsApp transport, mapping "nothing
 * configured" to the engines' localized error. The single home for that
 * lookup — callers outside this file (the AI auto-reply's typing
 * indicator, automation template sends) reuse it.
 */
export async function loadEngineTransport(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<WhatsAppTransport> {
  try {
    return await loadAccountTransport(db, accountId)
  } catch (err) {
    if (err instanceof TransportNotConfiguredError) {
      throw new Error(t('send.notConfigured'))
    }
    throw err
  }
}

/**
 * Mark an inbound message read and show "typing…" to the contact on
 * the account's active transport. Throws on any failure (no connection,
 * unknown contact, provider error) — callers treat it as best-effort.
 */
export async function engineSendTyping(args: {
  accountId: string
  contactId: string
  inboundMessageId: string
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (error || !contact) throw new Error(t('send.contactNotFound'))
  const target = resolveContactSendTarget(contact)
  if (!target) {
    throw new Error(
      t('send.noWhatsAppAddress', { phone: contact.phone || t('send.none') })
    )
  }
  const transport = await loadEngineTransport(db, args.accountId)
  await transport.sendTyping({
    to: target.target,
    inboundMessageId: args.inboundMessageId,
  })
}

interface SendToContactArgs {
  accountId: string
  conversationId: string
  contactId: string
}

/**
 * Account-scoped contact + conversation checks, transport lookup and
 * the recipient-variant retry around `send`. Returns the provider
 * message id. Persisting the message row stays with each caller — the
 * row shape is what differs between them.
 */
export async function sendToContact(
  args: SendToContactArgs,
  send: (transport: WhatsAppTransport, to: string) => Promise<string>,
): Promise<{ waMessageId: string; transport: WhatsAppTransport }> {
  const db = supabaseAdmin()

  // Scope the contact lookup by account_id, not user_id. The engines use
  // the service-role client (bypassing RLS); without this filter, an
  // authenticated user could fire their own automations against another
  // tenant's contact UUID and send via their own WhatsApp connection.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error(t('send.contactNotFound'))
  }

  // Same for the conversation the message lands in — see
  // conversation-scope.ts (GHSA-m4fx-g6pr-hrw8).
  await assertConversationInAccount(db, args.conversationId, args.accountId)

  // Phone number, or the business-scoped user ID when Meta has never
  // given us a number for this customer (issue #519).
  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error(
      t('send.noWhatsAppAddress', { phone: contact.phone || t('send.none') })
    )
  }
  const sanitized = sendTarget.target

  const transport = await loadEngineTransport(db, args.accountId)

  // Phone-variant retry — numbers registered with/without a trunk 0 and
  // Meta's sandbox quirks both need it to reliably land a message.
  const { result: waMessageId, workingTarget } = await sendWithRecipientVariants(
    transport,
    sanitized,
    sendTarget.isPhone,
    (to) => send(transport, to),
  )

  if (sendTarget.isPhone && workingTarget !== sanitized) {
    await db.from('contacts').update({ phone: workingTarget }).eq('id', contact.id)
  }

  return { waMessageId, transport }
}

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).

 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const { waMessageId } = await sendToContact(args, async (transport, to) =>
    (await transport.sendText({ to, text: args.text })).messageId,
  )

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  return { whatsapp_message_id: waMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL the provider fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const { waMessageId } = await sendToContact(args, async (transport, to) =>
    (
      await transport.sendMedia({
        to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
      })
    ).messageId,
  )

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the provider message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaTransport({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaTransport({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaTransport(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives. We DO persist the structured payload so
  // the inbox thread re-renders the buttons/rows the bot sent (round-
  // trip), matching the composer + automation send paths.
  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  // The structured payload goes to the transport as-is (native
  // buttons/list on Meta, a numbered text menu where the provider has
  // none) and is persisted below so the inbox re-renders it.
  const { waMessageId } = await sendToContact(input, async (transport, to) =>
    (await transport.sendInteractive({ to, payload: interactivePayload })).messageId,
  )

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)

  return { whatsapp_message_id: waMessageId }
}
