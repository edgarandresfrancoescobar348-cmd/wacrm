// H2 (third review): a send has one absolute deadline. The fetch only
// gets what is left of it, and a spent deadline sends nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openWaSend } = await import('./client')
const { SendBudgetExceededError } = await import('@/lib/whatsapp/transport/types')

const creds = { baseUrl: 'http://gw.example.com', apiKey: 'k' }
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})
afterEach(() => {
  fetchSpy.mockRestore()
})

describe('openWaSend — one absolute deadline (H2)', () => {
  it('a spent deadline aborts before any fetch', async () => {
    fetchSpy.mockResolvedValue(new Response('{"messageId":"m"}', { status: 201 }))
    await expect(
      openWaSend(creds, 's', 'send-text', { chatId: '1@c.us', text: 'x' }, { sendBy: Date.now() - 1 }),
    ).rejects.toBeInstanceOf(SendBudgetExceededError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the fetch only gets what is left of the deadline', async () => {
    fetchSpy.mockImplementation(
      (_url: unknown, init: unknown) =>
        new Promise((_, reject) => {
          const signal = (init as RequestInit).signal!
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    )
    const started = Date.now()
    await expect(
      openWaSend(creds, 's', 'send-text', { chatId: '1@c.us', text: 'x' }, { sendBy: started + 300 }),
    ).rejects.toThrow()
    // Aborted at the absolute deadline (≈300 ms), not the 45 s send timeout.
    expect(Date.now() - started).toBeLessThan(450)
  })
})
