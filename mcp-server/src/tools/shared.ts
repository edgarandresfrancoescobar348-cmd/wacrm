// ============================================================
// Shared helpers for tool handlers.
//
// Every tool returns MCP `content`. On success we hand back the JSON
// payload as pretty text (models read it fine and it keeps the tool
// layer dumb). On a WacrmApiError we return an `isError` result with
// the stable error code, so the model can reason about *why* it
// failed (missing scope, rate limit, not found) instead of seeing a
// stack trace.
// ============================================================

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WacrmApiError } from '../client.js';

export function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * Wrap a tool handler so any WacrmApiError becomes a clean, model-
 * readable error result and unexpected throws don't crash the server.
 */
export function handle<A>(
  fn: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof WacrmApiError) {
        return errorResult(`wacrm API error [${err.code}]: ${err.message}`);
      }
      return errorResult(`Unexpected error: ${(err as Error).message}`);
    }
  };
}

/**
 * Template params as the public API takes them: positional body values,
 * or the structured form when the template's header has a variable.
 */
export const templateParamsSchema = z
  .union([
    z.array(z.string()),
    z.object({
      body: z.array(z.string()).optional().describe('Positional body variables, in order.'),
      headerText: z
        .string()
        .optional()
        .describe('Value for the header variable {{1}} — required when the template header has one.'),
    }),
  ])
  .optional();
