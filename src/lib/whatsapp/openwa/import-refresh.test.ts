import { describe, expect, it } from 'vitest'

import { refreshPatch, type IncomingMessageRow, type StoredMessageState } from './import-refresh'

const stored = (over: Partial<StoredMessageState> = {}): StoredMessageState => ({
  id: 'm1',
  sender_type: 'agent',
  status: 'sent',
  content_meta: null,
  is_forwarded: false,
  forwarding_score: null,
  media_meta: null,
  ...over,
})
const incoming = (over: Partial<IncomingMessageRow> = {}): IncomingMessageRow => ({
  sender_type: 'agent',
  status: 'sent',
  content_type: 'text',
  content_text: 'oi',
  content_meta: null,
  media_url: null,
  media_type: null,
  revoked_at: null,
  ...over,
})

describe('refreshPatch (phase 5f: re-import updates what is stored)', () => {
  it('old single ticks go up to what the phone shows', () => {
    expect(refreshPatch(stored(), incoming({ status: 'read' }))).toEqual({ status: 'read' })
    expect(refreshPatch(stored({ status: 'delivered' }), incoming({ status: 'read' }))).toEqual({ status: 'read' })
  })

  it('never down, never on a failed send, never on the contact\'s messages', () => {
    expect(refreshPatch(stored({ status: 'read' }), incoming({ status: 'delivered' }))).toBeNull()
    expect(refreshPatch(stored({ status: 'failed' }), incoming({ status: 'read' }))).toBeNull()
    expect(refreshPatch(stored({ sender_type: 'customer', status: 'delivered' }), incoming({ sender_type: 'customer', status: 'read' }))).toBeNull()
  })

  it('fills forwarded and media details, keeps what is known and "played"', () => {
    expect(
      refreshPatch(
        stored({ media_meta: { played: true, sizeBytes: 10 } }),
        incoming({ is_forwarded: true, forwarding_score: 5, media_meta: { durationSeconds: 9, sizeBytes: 99, played: false } }),
      ),
    ).toEqual({ is_forwarded: true, forwarding_score: 5, media_meta: { played: true, sizeBytes: 10, durationSeconds: 9 } })
  })

  it('never touches the text — an edit or a deletion made here stays', () => {
    expect(refreshPatch(stored({ status: 'read' }), incoming({ status: 'read', content_text: 'texto original' }))).toBeNull()
  })

  it('a waiting placeholder becomes the real message; a placeholder never replaces content', () => {
    const real = incoming({ sender_type: 'customer', status: 'delivered', content_type: 'audio', content_text: null, content_meta: { kind: 'voice' }, media_url: '/m', media_type: 'audio/ogg' })
    expect(refreshPatch(stored({ sender_type: 'customer', status: 'delivered', content_meta: { kind: 'waiting' } }), real)).toEqual({
      content_type: 'audio',
      content_text: null,
      content_meta: { kind: 'voice' },
      media_url: '/m',
      media_type: 'audio/ogg',
      revoked_at: null,
    })
    expect(refreshPatch(stored({ sender_type: 'customer', status: 'delivered' }), incoming({ sender_type: 'customer', status: 'delivered', content_text: null, content_meta: { kind: 'waiting' } }))).toBeNull()
  })
})
