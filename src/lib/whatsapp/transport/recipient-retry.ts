import type { WhatsAppTransport } from './types'

export interface RecipientRetryResult<T> {
  result: T
  /** The spelling that went through — differs from the input when a
   *  variant had to be tried. */
  workingTarget: string
}

/**
 * Run `send` against `target`, retrying across the transport's
 * recipient variants while it rejects with a "recipient not allowed"
 * error. Any other error is thrown straight away; if every variant is
 * rejected the last rejection is thrown.
 *
 * `isPhone=false` (a BSUID) gets a single attempt — an opaque id has
 * exactly one correct spelling.
 *
 * This is the loop every sender used to carry inline (send-message,
 * automations, flows, broadcasts); behaviour is unchanged.
 */
export async function sendWithRecipientVariants<T>(
  transport: WhatsAppTransport,
  target: string,
  isPhone: boolean,
  send: (to: string) => Promise<T>,
  onRetry?: (variant: string) => void,
): Promise<RecipientRetryResult<T>> {
  const variants = isPhone ? transport.recipientVariants(target) : [target]
  let lastError: unknown = null
  for (const variant of variants) {
    try {
      const result = await send(variant)
      return { result, workingTarget: variant }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!transport.isRecipientRetryable(message)) throw err
      lastError = err
      onRetry?.(variant)
    }
  }
  throw lastError ?? new Error('No recipient variant to send to')
}
