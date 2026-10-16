import { describe, expect, it } from 'vitest'

import { previewLead } from './preview-lead'

describe('previewLead (phase 5f: WhatsApp list preview)', () => {
  it('yours: the ticks, in a chat or a group', () => {
    expect(previewLead({ is_group: false, last_message_status: 'read', last_message_sender: null })).toEqual({ kind: 'ticks', status: 'read' })
    expect(previewLead({ is_group: true, last_message_status: 'delivered', last_message_sender: 'Vitor-' })).toEqual({ kind: 'ticks', status: 'delivered' })
  })
  it('a group member: their name ("Luciana Alves: …", "~Central Evolution: …")', () => {
    expect(previewLead({ is_group: true, last_message_status: null, last_message_sender: 'Luciana Alves' })).toEqual({ kind: 'sender', name: 'Luciana Alves' })
    expect(previewLead({ is_group: true, last_message_status: null, last_message_sender: '~Central Evolution' })).toEqual({ kind: 'sender', name: '~Central Evolution' })
  })
  it('a one-to-one chat never names the sender — "Grupo Bexp" is a business, not a group', () => {
    expect(previewLead({ is_group: false, last_message_status: null, last_message_sender: 'Bexp' })).toBeNull()
    expect(previewLead({ is_group: false, last_message_status: null, last_message_sender: null })).toBeNull()
  })
  it('a group message with no known sender: nothing, not ": …"', () => {
    expect(previewLead({ is_group: true, last_message_status: null, last_message_sender: ' ' })).toBeNull()
  })
})
