import { describe, expect, it } from 'vitest'

import { MEDIA_MAX_HEIGHT, MEDIA_MAX_WIDTH, jpegSize, mediaBox, mediaBoxFor } from './media-box'

// Phase 5g, real account: a photo of a document with a caption stretched
// across the conversation as a cropped strip.
// 72×96 JPEGs, baseline and progressive (WhatsApp's previews are progressive).
const BASELINE = '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCABgAEgBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/2Q=='
const PROGRESSIVE = '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wgALCABgAEgBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/2gAIAQEAAAABoAAAAAAAAAAAAAAAAAAf/8QAFBABAAAAAAAAAAAAAAAAAAAAYP/aAAgBAQABBQJZ/8QAFBABAAAAAAAAAAAAAAAAAAAAYP/aAAgBAQAGPwJZ/8QAFBABAAAAAAAAAAAAAAAAAAAAYP/aAAgBAQABPyFZ/9oACAEBAAAAEAAAAAAAAAAAAAAAAAAP/8QAFBABAAAAAAAAAAAAAAAAAAAAYP/aAAgBAQABPxBZ/9k='

describe('mediaBoxFor (like WhatsApp)', () => {
  it('as wide as the photo up to 330 px, its proportions kept', () => {
    expect(mediaBoxFor(1600, 1200)).toEqual({ width: MEDIA_MAX_WIDTH, height: 248 })
    expect(mediaBoxFor(200, 100)).toEqual({ width: 200, height: 100 })
  })

  it('a tall photo (a document) stops at the maximum height and is cropped at the centre', () => {
    expect(mediaBoxFor(1200, 1600)).toEqual({ width: MEDIA_MAX_WIDTH, height: MEDIA_MAX_HEIGHT })
    expect(mediaBoxFor(1080, 4000)).toEqual({ width: MEDIA_MAX_WIDTH, height: MEDIA_MAX_HEIGHT })
  })

  it('a tiny photo still gets room for its time and ticks; nonsense sizes give nothing', () => {
    expect(mediaBoxFor(40, 40)).toEqual({ width: 120, height: 120 })
    expect(mediaBoxFor(0, 10)).toBeNull()
  })
})

describe('jpegSize', () => {
  it('reads the size of a baseline and a progressive JPEG preview', () => {
    expect(jpegSize(BASELINE)).toEqual({ width: 72, height: 96 })
    expect(jpegSize(PROGRESSIVE)).toEqual({ width: 72, height: 96 })
  })

  it('anything else is null', () => {
    expect(jpegSize(null)).toBeNull()
    expect(jpegSize('not base64 at all!')).toBeNull()
    expect(jpegSize(btoa('GIF89a....'))).toBeNull()
  })
})

describe('mediaBox', () => {
  it("WhatsApp's declared size first, else the preview's proportions, else nothing", () => {
    expect(mediaBox({ width: 1200, height: 900, thumbnail: BASELINE })).toEqual({ width: 330, height: 248 })
    expect(mediaBox({ thumbnail: PROGRESSIVE })).toEqual({ width: 120, height: 160 })
    expect(mediaBox({})).toBeNull()
    expect(mediaBox(null)).toBeNull()
  })
})
