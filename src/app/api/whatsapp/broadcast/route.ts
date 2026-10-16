import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  loadAccountTransport,
  SendBudgetExceededError,
  sendWithRecipientVariants,
  TransportNotConfiguredError,
  type WhatsAppTransport,
} from '@/lib/whatsapp/transport'
import {
  broadcastSendBy,
  broadcastSendDeadline,
  paceBroadcastSend,
} from '@/lib/whatsapp/transport/pacing'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { resolveTemplateRow, templateUsableOn } from '@/lib/whatsapp/template-body'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// On a QR-code (OpenWA) connection every send waits out the account's
// broadcast pacing (transport/pacing.ts), so one batch of 10 can take
// most of a minute. Meta sends are not paced.
export const maxDuration = 300

interface BroadcastResult {
  phone: string
  /** `deferred`: not attempted — out of this request's time budget
   *  (paced QR connection); the wizard re-queues it. */
  status: 'sent' | 'failed' | 'deferred'
  whatsapp_message_id?: string
  error?: string
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  /** The wizard's broadcast_recipients row: send checkpoint + provider
   *  de-duplication key. Optional for older callers. */
  recipient_id?: string
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[]
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). When set, takes
   * precedence over `params` for the body too — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  const startedAt = Date.now()
  const deadline = broadcastSendDeadline(maxDuration, startedAt)
  const sendBy = broadcastSendBy(maxDuration, startedAt)
  try {
    // Requires the 'agent' role — `canSendMessages` in lib/auth/roles is
    // explicit that running broadcasts is a write operation and that
    // viewers are read-only.
    //
    // This endpoint writes NOTHING to the database: it reads the config
    // and template, then calls the WhatsApp provider directly. So unlike the rest of the
    // app there was no RLS policy backstopping a missing role check —
    // resolving `account_id` straight off the profile (which only needs
    // 'viewer') was the ONLY gate, and it let a viewer blast a template
    // to arbitrary phone numbers from the account's WhatsApp number.
    // Nothing about that is recoverable after the fact, so the check has
    // to happen here.
    const { supabase, accountId, userId } = await requireRole('agent')

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            t('broadcast.recipientsRequired'),
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: t('broadcast.templateNameRequired') },
        { status: 400 }
      )
    }

    let transport: WhatsAppTransport
    try {
      transport = await loadAccountTransport(supabase, accountId)
    } catch (err) {
      if (!(err instanceof TransportNotConfiguredError)) throw err
      return NextResponse.json(
        {
          error:
            t('common.whatsappNotConfiguredSetup'),
        },
        { status: 400 }
      )
    }

    // Load the template row once so the transport can build
    // header + button components on each iteration. Loading inside
    // the loop would N+1 against Supabase for every recipient.
    // Guard against a malformed local row crashing every send in
    // the loop with the same opaque TypeError — fail loudly once.
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language,
    )
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        {
          error:
            t('broadcast.templateMalformed'),
        },
        { status: 500 },
      )
    }
    const templateRow = resolvedTemplate.row
    if (!templateUsableOn(transport.capabilities.templates, templateRow)) {
      return NextResponse.json(
        { error: t('broadcast.templateNotApproved'), code: 'template_not_approved' },
        { status: 400 }
      )
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0
    let deferredCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: t('broadcast.invalidPhoneFormat'),
        })
        failedCount++
        continue
      }

      const idempotencyKey = recipient.recipient_id
        ? `broadcast-recipient:${recipient.recipient_id}`
        : undefined
      const sendArgs = {
        templateName: template_name,
        language: resolvedTemplate.language,
        template: templateRow,
        messageParams: recipient.messageParams,
        params: recipient.params ?? [],
        sendBy,
        idempotencyKey,
      }
      // Slow send-independent work (a media header to inline) BEFORE the
      // paced slot — the slot then only waits on the provider.
      try {
        await transport.prepareTemplate?.({ ...sendArgs, to: sanitized })
      } catch (error) {
        if (error instanceof SendBudgetExceededError) {
          results.push({ phone: recipient.phone, status: 'deferred' })
          deferredCount++
          continue
        }
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: error instanceof Error ? error.message : t('common.unknownError'),
        })
        failedCount++
        continue
      }

      // Provider pacing (a no-op on Meta), bounded by this request's
      // budget and re-checked after the wait: a recipient that can't
      // START in time is returned as `deferred` (not sent, not failed)
      // for the wizard to re-queue.
      const mayStart = await paceBroadcastSend(
        accountId,
        transport.capabilities.broadcastDelayMs,
        { deadline }
      )
      if (!mayStart) {
        results.push({ phone: recipient.phone, status: 'deferred' })
        deferredCount++
        continue
      }

      // Retry with phone variants on "not in allowed list" so numbers
      // that differ only in a trunk-prefix 0 still reach recipients.
      // Checkpoint BEFORE the external effect (the wizard's row).
      if (recipient.recipient_id) {
        await supabase
          .from('broadcast_recipients')
          .update({ send_started_at: new Date().toISOString() })
          .eq('id', recipient.recipient_id)
      }

      let sentMessageId: string | null = null
      let lastError: string | null = null
      try {
        const { result } = await sendWithRecipientVariants(
          transport,
          sanitized,
          true,
          (to) => transport.sendTemplate({ ...sendArgs, to })
        )
        sentMessageId = result.messageId
      } catch (error) {
        // Aborted at the budget: outcome unknown. Where the provider
        // de-duplicates (same key) the wizard may safely re-queue it;
        // otherwise report it failed rather than risk a duplicate.
        const budgetHit = error instanceof SendBudgetExceededError || Date.now() >= sendBy - 1000
        if (budgetHit && transport.capabilities.idempotentSends && idempotencyKey) {
          results.push({ phone: recipient.phone, status: 'deferred' })
          deferredCount++
          continue
        }
        lastError =
          error instanceof Error ? error.message : t('common.unknownError')
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || t('common.unknownError'),
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      deferred: deferredCount,
      results,
    })
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}
