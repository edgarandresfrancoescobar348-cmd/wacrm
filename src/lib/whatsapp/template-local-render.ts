// ============================================================
// Local template rendering — how a template is sent on a connection
// where Meta's template approval does not exist (QR code / OpenWA).
//
// The local `message_templates` row is rendered with the same variable
// rules as the Meta send-builder: header text {{1}}, body {{1..n}},
// footer as-is. Buttons have no wire equivalent on a regular number, so
// they become text lines (a link or phone to tap, a code to copy, a
// quick-reply label). A media header turns the message into a media
// message with the rendered text as its caption.
// ============================================================

import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { renderTemplateBody } from '@/lib/whatsapp/template-body'

export interface RenderedLocalTemplate {
  text: string
  media: { kind: 'image' | 'video' | 'document'; url: string } | null
}

/** WhatsApp caps captions at 1024 chars; text messages at 4096. */
export const LOCAL_CAPTION_MAX = 1024

export function renderLocalTemplate(
  template: MessageTemplate,
  values: SendTimeParams & { legacyBody?: string[] } = {},
): RenderedLocalTemplate {
  const bodyParams = values.body ?? values.legacyBody ?? []
  const lines: string[] = []

  let media: RenderedLocalTemplate['media'] = null
  if (template.header_type === 'text' && template.header_content?.trim()) {
    const header = renderTemplateBody(
      template.header_content.trim(),
      values.headerText ? [values.headerText] : [],
    )
    lines.push(`*${header}*`)
  } else if (
    template.header_type === 'image' ||
    template.header_type === 'video' ||
    template.header_type === 'document'
  ) {
    const url = values.headerMediaUrl || template.header_media_url
    if (url) media = { kind: template.header_type, url }
  }

  lines.push(renderTemplateBody(template.body_text, bodyParams))

  if (template.footer_text?.trim()) {
    lines.push('', `_${template.footer_text.trim()}_`)
  }

  const buttonLines = (template.buttons ?? [])
    .map((button, index) => {
      const override = values.buttonParams?.[index]
      switch (button.type) {
        case 'URL': {
          const url = button.url.includes('{{1}}')
            ? button.url.replace('{{1}}', override ?? button.example ?? '')
            : button.url
          return `🔗 ${button.text}: ${url}`
        }
        case 'PHONE_NUMBER':
          return `📞 ${button.text}: ${button.phone_number}`
        case 'COPY_CODE':
          return `🔑 ${button.text}: ${override ?? button.example}`
        case 'QUICK_REPLY':
          return `▫️ ${button.text}`
        default:
          return null
      }
    })
    .filter((line): line is string => Boolean(line))
  if (buttonLines.length > 0) lines.push('', ...buttonLines)

  return { text: lines.join('\n').trim(), media }
}
