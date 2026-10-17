// ============================================================
// Who may do what with one of the account's WhatsApp numbers (phase 6).
//
//   view        see it in Settings and its state: any member. A personal
//               number's conversations stay its owner's (RLS, 086) —
//               this is only about the number itself.
//   operate     connect it, show its QR / pairing code, restart it,
//               import its history, change its settings: a business
//               number's admins; a personal number's owner only (nobody
//               else may pair a phone into someone's personal inbox).
//   disconnect  log it out, remove it: as operate, plus an admin on a
//               personal number (a member leaving) — without ever seeing
//               its conversations.
// ============================================================

import { ForbiddenError, requireRole, type AccountContext } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadConnection, type WaConnection } from './connections'

export type ConnectionAction = 'view' | 'operate' | 'disconnect'

export function mayOnConnection(
  c: Pick<WaConnection, 'scope' | 'ownerUserId'>,
  viewer: Pick<AccountContext, 'userId' | 'role'>,
  action: ConnectionAction,
): boolean {
  if (action === 'view') return true
  const isAdmin = hasMinRole(viewer.role, 'admin')
  if (c.scope === 'business') return isAdmin
  const mine = c.ownerUserId === viewer.userId
  return action === 'operate' ? mine : mine || isAdmin
}

/**
 * The caller's account context and the number `connectionId`, when it is
 * one of their account's numbers and they may do `action` with it.
 * Throws ForbiddenError otherwise (the same answer for "not yours" and
 * "no such number").
 */
export async function requireConnection(
  connectionId: string | null | undefined,
  action: ConnectionAction,
): Promise<{ ctx: AccountContext; connection: WaConnection }> {
  const ctx = await requireRole('viewer')
  if (!connectionId || !/^[0-9a-f-]{36}$/i.test(connectionId)) throw new ForbiddenError('Unknown WhatsApp number')
  const connection = await loadConnection(supabaseAdmin(), connectionId)
  if (!connection || connection.accountId !== ctx.accountId) throw new ForbiddenError('Unknown WhatsApp number')
  if (!mayOnConnection(connection, ctx, action)) throw new ForbiddenError()
  return { ctx, connection }
}

/**
 * Who may move a number between Pessoal and Empresa (phase 6b; mirrors
 * set_connection_scope, migration 089): an admin makes a business QR
 * number personal; only its owner makes a personal one the team's. The
 * official number is always business.
 */
export function scopeChoices(
  c: Pick<WaConnection, 'provider' | 'scope' | 'ownerUserId' | 'removedAt'>,
  viewer: Pick<AccountContext, 'userId' | 'role'>,
): { can_make_personal: boolean; can_make_business: boolean } {
  const live = !c.removedAt && c.provider === 'openwa'
  return {
    can_make_personal: live && c.scope === 'business' && hasMinRole(viewer.role, 'admin'),
    can_make_business: live && c.scope === 'personal' && c.ownerUserId === viewer.userId,
  }
}
