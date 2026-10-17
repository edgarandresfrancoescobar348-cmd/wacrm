import { describe, expect, it } from 'vitest'

import { mediaMetaFor } from './parity'

describe('mediaMetaFor', () => {
  // Phase 5g: the gateway's declared pixel size (patch 7) sizes the bubble before the photo loads.
  it("keeps WhatsApp's declared pixel size of a photo / video", () => {
    expect(mediaMetaFor({ type: 'image', media: { mimetype: 'image/jpeg', width: 1200, height: 1600 } })).toEqual({
      mimetype: 'image/jpeg',
      width: 1200,
      height: 1600,
    })
    expect(mediaMetaFor({ type: 'image', media: { mimetype: 'image/jpeg', width: 1200 } })).toEqual({ mimetype: 'image/jpeg' })
  })

  it('ticks, length, pages, size and played as before', () => {
    expect(mediaMetaFor({ type: 'voice', ack: 4, media: { durationSeconds: 3.6 } })).toEqual({ durationSeconds: 4, played: true })
    expect(mediaMetaFor({ type: 'chat' })).toBeNull()
  })
})
