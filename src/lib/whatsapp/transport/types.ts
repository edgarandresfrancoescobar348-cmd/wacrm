// ============================================================
// WhatsApp transport — the one boundary every sender goes through.
//
// An account talks to WhatsApp through exactly one active connection
// (`whatsapp_config.provider`):
//
//   - 'meta'   — Meta's official Cloud API (`meta-api.ts`).
//   - 'openwa' — a self-hosted OpenWA gateway driving a regular
//                WhatsApp number paired by QR code (`openwa-api.ts`).
//
// Callers (inbox send, reactions, broadcasts, automations, flows, the AI
// auto-reply, the public API) load a transport with
// `loadAccountTransport` and call these methods. They never branch on
// the provider themselves: what differs between the two lives here, and
// what a caller needs to know about the difference (does the 24h window
// apply? are templates Meta-approved?) is exposed as `capabilities`.
// ============================================================

import type { MessageTemplate } from '@/types'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'

export type WhatsAppProvider = 'meta' | 'openwa'

export const WHATSAPP_PROVIDERS: readonly WhatsAppProvider[] = ['meta', 'openwa']

export function isWhatsAppProvider(value: unknown): value is WhatsAppProvider {
  return value === 'meta' || value === 'openwa'
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface TransportCapabilities {
  /**
   * 'meta_approved' — templates are submitted to Meta and sent by name.
   * 'local'         — templates are local text snippets: rendered here
   *                   (header/body/footer + variables) and sent as a
   *                   plain text or media-with-caption message.
   */
  templates: 'meta_approved' | 'local'
  /** Meta's 24h customer-service window applies to free-form sends. */
  serviceWindow: boolean
  /**
   * 'native'        — buttons / lists go out as WhatsApp interactive
   *                   messages and taps come back with the option id.
   * 'numbered_text' — they go out as a numbered text menu and the
   *                   customer's typed reply is mapped back to the
   *                   option id on the way in (see numbered-menu.ts).
   */
  interactive: 'native' | 'numbered_text'
  /**
   * Minimum pause between two broadcast sends from this account. 0 for
   * Meta (its own rate limiting applies); a ban-risk guard for a
   * regular number paired by QR.
   */
  broadcastDelayMs: number
  /**
   * The provider de-duplicates a send repeated with the same
   * `idempotencyKey` (OpenWA: 24 h). A broadcast recipient interrupted
   * mid-send can then be re-sent safely; without it (Meta) it is failed
   * as "interrupted" rather than risk a duplicate.
   */
  idempotentSends: boolean
}

/** Options every send accepts (broadcast time budget, de-duplication). */
export interface SendControl {
  /**
   * Absolute epoch ms by which the provider call must have finished —
   * the handler's time budget. The request is aborted at that moment
   * (and refused if it has already passed).
   */
  sendBy?: number
  /** Provider-side de-duplication key (see idempotentSends). */
  idempotencyKey?: string
}

export interface SendResult {
  /** Provider message id — persisted as `messages.message_id`. */
  messageId: string
}

export interface SendTextArgs extends SendControl {
  to: string
  text: string
  /** Provider id of the message being quoted. */
  contextMessageId?: string
}

export interface SendMediaArgs extends SendControl {
  to: string
  kind: MediaKind
  /** Public URL the provider fetches at send time. */
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs extends SendControl {
  to: string
  templateName: string
  language?: string
  /** Local template row. Required by local-template transports. */
  template?: MessageTemplate | null
  /** Structured per-send values (header/body/buttons). */
  messageParams?: SendTimeParams
  /** Legacy positional body params. */
  params?: string[]
  contextMessageId?: string
}

export interface SendInteractiveArgs {
  to: string
  payload: InteractiveMessagePayload
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  /** Provider id of the message being reacted to. */
  targetMessageId: string
  /** Single emoji, or '' to remove our reaction. */
  emoji: string
}

export interface TypingArgs {
  to: string
  /** Provider id of the inbound message about to be answered. */
  inboundMessageId: string
}

export interface WhatsAppTransport {
  readonly provider: WhatsAppProvider
  readonly capabilities: TransportCapabilities

  sendText(args: SendTextArgs): Promise<SendResult>
  sendMedia(args: SendMediaArgs): Promise<SendResult>
  sendTemplate(args: SendTemplateArgs): Promise<SendResult>
  sendInteractive(args: SendInteractiveArgs): Promise<SendResult>
  sendReaction(args: SendReactionArgs): Promise<void>
  /**
   * Do the slow, send-independent work for a template send up front
   * (download a media header that will be inlined) so the paced send
   * itself only waits on the provider. Optional; cached per transport.
   */
  prepareTemplate?(args: SendTemplateArgs): Promise<void>
  /**
   * Mark the inbound message read and show "typing…". Best-effort —
   * callers swallow failures; the reply that follows is what matters.
   */
  sendTyping(args: TypingArgs): Promise<void>

  /**
   * Alternative spellings of a phone number worth trying when the
   * provider rejects the first one as "not an allowed recipient"
   * (Meta's sandbox + trunk-prefix quirks). A single entry means "no
   * retry".
   */
  recipientVariants(phone: string): string[]
  /** Should this send error move on to the next recipient variant? */
  isRecipientRetryable(message: string): boolean
}

/** Prefix for a provider's send error in logs and API error messages. */
export function providerErrorLabel(provider: WhatsAppProvider): string {
  return provider === 'meta' ? 'Meta API error' : 'OpenWA error'
}

/** The send would not finish inside the caller's time budget. */
export class SendBudgetExceededError extends Error {
  constructor(message = 'Send aborted: time budget exhausted') {
    super(message)
    this.name = 'SendBudgetExceededError'
  }
}

/**
 * Remaining ms before `sendBy`, capped at `cap`. Throws
 * SendBudgetExceededError when nothing is left.
 */
export function budgetTimeout(sendBy: number | undefined, cap: number, now = Date.now()): number {
  if (sendBy === undefined) return cap
  const left = sendBy - now
  if (left <= 0) throw new SendBudgetExceededError()
  return Math.min(cap, left)
}

/** No WhatsApp connection usable for sending on this account. */
export class TransportNotConfiguredError extends Error {
  constructor(message = 'WhatsApp not configured') {
    super(message)
    this.name = 'TransportNotConfiguredError'
  }
}
