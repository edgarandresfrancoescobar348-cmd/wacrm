// ============================================================
// Meta Cloud API transport — a thin adapter over `meta-api.ts`.
//
// Behaviour is exactly what the callers did inline before the transport
// existed: same request shapes, same phone-variant retry rule, same
// errors. Nothing here interprets a template or an interactive payload
// beyond mapping it onto the existing Meta senders.
// ============================================================

import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendTextMessage,
  sendTypingIndicator,
} from '@/lib/whatsapp/meta-api'
import {
  isRecipientNotAllowedError,
  phoneVariants,
} from '@/lib/whatsapp/phone-utils'
import type { TransportCapabilities, WhatsAppTransport } from './types'

export interface MetaCredentials {
  phoneNumberId: string
  /** Decrypted. */
  accessToken: string
}

export const META_CAPABILITIES: TransportCapabilities = {
  templates: 'meta_approved',
  serviceWindow: true,
  interactive: 'native',
  broadcastDelayMs: 0,
}

export function createMetaTransport(creds: MetaCredentials): WhatsAppTransport {
  const { phoneNumberId, accessToken } = creds
  return {
    provider: 'meta',
    capabilities: META_CAPABILITIES,

    async sendText({ to, text, contextMessageId }) {
      return sendTextMessage({ phoneNumberId, accessToken, to, text, contextMessageId })
    },

    async sendMedia({ to, kind, link, caption, filename, contextMessageId }) {
      return sendMediaMessage({
        phoneNumberId,
        accessToken,
        to,
        kind,
        link,
        caption,
        filename,
        contextMessageId,
      })
    },

    async sendTemplate({
      to,
      templateName,
      language,
      template,
      messageParams,
      params,
      contextMessageId,
    }) {
      return sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to,
        templateName,
        language,
        template: template ?? undefined,
        messageParams,
        params,
        contextMessageId,
      })
    },

    async sendInteractive({ to, payload, contextMessageId }) {
      if (payload.kind === 'buttons') {
        return sendInteractiveButtons({
          phoneNumberId,
          accessToken,
          to,
          bodyText: payload.body,
          headerText: payload.header || undefined,
          footerText: payload.footer || undefined,
          buttons: payload.buttons,
          contextMessageId,
        })
      }
      return sendInteractiveList({
        phoneNumberId,
        accessToken,
        to,
        bodyText: payload.body,
        buttonLabel: payload.button_label,
        headerText: payload.header || undefined,
        footerText: payload.footer || undefined,
        sections: payload.sections,
        contextMessageId,
      })
    },

    async sendReaction({ to, targetMessageId, emoji }) {
      await sendReactionMessage({ phoneNumberId, accessToken, to, targetMessageId, emoji })
    },

    async sendTyping({ inboundMessageId }) {
      await sendTypingIndicator({ phoneNumberId, accessToken, messageId: inboundMessageId })
    },

    recipientVariants: phoneVariants,
    isRecipientRetryable: isRecipientNotAllowedError,
  }
}
