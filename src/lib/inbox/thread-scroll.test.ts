import { describe, expect, it } from 'vitest'

import { isAtBottom, scrollAction, threadShape } from './thread-scroll'

// Phase 5g, real account: the thread jumped back to the bottom all the
// time — it scrolled to the end on every change of its messages (a tick,
// "played", a voice note's length, a resync). Only opening, your own send,
// or a new message while already at the bottom move it now.
const ids = (...xs: string[]) => xs.map((id) => ({ id }))
const shape = (...xs: string[]) => threadShape('c1', ids(...xs))
const reading = { atBottom: false, ownSend: false }
const atEnd = { atBottom: true, ownSend: false }

describe('scrollAction', () => {
  it('opening a conversation (or its first page arriving) goes to the newest message', () => {
    expect(scrollAction(null, shape('a', 'b'), reading)).toBe('bottom')
    expect(scrollAction(threadShape('c0', ids('x')), shape('a', 'b'), reading)).toBe('bottom')
    expect(scrollAction(threadShape('c1', []), shape('a', 'b'), reading)).toBe('bottom')
    expect(scrollAction(null, threadShape('c1', []), reading)).toBe('none')
  })

  it('updates that add nothing — ticks, played, a length, a resync with nothing new — never move it', () => {
    expect(scrollAction(shape('a', 'b'), shape('a', 'b'), reading)).toBe('none')
    expect(scrollAction(shape('a', 'b'), shape('a', 'b'), atEnd)).toBe('none')
  })

  it('a new message follows only when the user is at the bottom; reading above, it shows "↓ new"', () => {
    expect(scrollAction(shape('a', 'b'), shape('a', 'b', 'c'), atEnd)).toBe('bottom')
    expect(scrollAction(shape('a', 'b'), shape('a', 'b', 'c'), reading)).toBe('indicator')
  })

  it('your own send always goes down', () => {
    expect(scrollAction(shape('a', 'b'), shape('a', 'b', 'temp-1'), { atBottom: false, ownSend: true })).toBe('bottom')
    // …and its stored row replacing the optimistic one keeps you there.
    expect(scrollAction(shape('a', 'b', 'temp-1'), shape('a', 'b', 'c'), atEnd)).toBe('bottom')
  })

  it('older messages loaded at the top keep the reading position', () => {
    expect(scrollAction(shape('c', 'd'), shape('a', 'b', 'c', 'd'), reading)).toBe('preserve')
    // Both ends grew (a resync after older pages): don't pull a reader down.
    expect(scrollAction(shape('c', 'd'), shape('a', 'c', 'd', 'e'), reading)).toBe('preserve')
    expect(scrollAction(shape('c', 'd'), shape('a', 'c', 'd', 'e'), atEnd)).toBe('bottom')
  })
})

describe('isAtBottom', () => {
  it('within 80 px of the end', () => {
    expect(isAtBottom({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4200 })).toBe(true)
    expect(isAtBottom({ scrollHeight: 5000, clientHeight: 800, scrollTop: 4130 })).toBe(true)
    expect(isAtBottom({ scrollHeight: 5000, clientHeight: 800, scrollTop: 3000 })).toBe(false)
  })
})
