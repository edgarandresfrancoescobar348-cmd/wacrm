// ============================================================
// /api/whatsapp/connections — the account's WhatsApp numbers (phase 6).
//
//   GET  — every member: the numbers (selo, label, status, owner), what
//          the viewer may do with each, and which numbers they may add.
//          Removed numbers come too (`removed_at`): the inbox still badges
//          their conversations, Settings leaves them out.
//          A personal number shows its phone to its owner only; its
//          conversations are never in here (RLS, migration 073).
//   POST { scope: 'personal' | 'business', label? } — add a QR number,
//          not yet paired ("Conectar" in its detail shows the QR).
//          Business: admins. Personal: any agent, for themselves.
//          The official number is added by saving its Meta credentials
//          (/api/whatsapp/config).
// ============================================================

import { NextResponse } from 'next/server'

import { ForbiddenError, requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createQrConnection } from '@/lib/whatsapp/connection-admin'
import { mayOnConnection } from '@/lib/whatsapp/connection-access'
import {
  defaultBusinessConnection,
  loadAccountConnections,
  toPublicConnection,
} from '@/lib/whatsapp/connections'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const admin = supabaseAdmin()
    const numbers = await loadAccountConnections(admin, ctx.accountId, { includeRemoved: true })
    const owners = [...new Set(numbers.map((n) => n.ownerUserId).filter((id): id is string => Boolean(id)))]
    const names = new Map<string, string>()
    if (owners.length) {
      const { data } = await admin
        .from('profiles')
        .select('user_id, full_name')
        .eq('account_id', ctx.accountId)
        .in('user_id', owners)
      for (const p of (data ?? []) as { user_id: string; full_name: string | null }[]) {
        if (p.full_name) names.set(p.user_id, p.full_name)
      }
    }
    const isAdmin = hasMinRole(ctx.role, 'admin')
    const defaultId = defaultBusinessConnection(numbers)?.id ?? null
    return NextResponse.json({
      connections: numbers.map((n) => ({
        ...toPublicConnection(n, { userId: ctx.userId, isAdmin }, {
          ownerName: n.ownerUserId ? (names.get(n.ownerUserId) ?? null) : null,
          defaultId,
        }),
        can_operate: mayOnConnection(n, ctx, 'operate'),
        can_disconnect: mayOnConnection(n, ctx, 'disconnect'),
      })),
      can_add: {
        official: isAdmin && !numbers.some((n) => n.provider === 'meta' && !n.removedAt),
        business_qr: isAdmin,
        personal_qr: hasMinRole(ctx.role, 'agent'),
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const limit = checkRateLimit(`openwa-admin:${ctx.userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    const body = (await request.json().catch(() => ({}))) as { scope?: unknown; label?: unknown }
    if (body.scope !== 'personal' && body.scope !== 'business') {
      return NextResponse.json({ error: "scope must be 'personal' or 'business'", field: 'scope' }, { status: 400 })
    }
    if (body.scope === 'business' && !hasMinRole(ctx.role, 'admin')) throw new ForbiddenError()
    if (body.scope === 'personal' && !hasMinRole(ctx.role, 'agent')) throw new ForbiddenError()
    const label = typeof body.label === 'string' ? body.label.slice(0, 60) : null
    const created = await createQrConnection(supabaseAdmin(), {
      accountId: ctx.accountId,
      scope: body.scope,
      userId: ctx.userId,
      label,
    })
    const isAdmin = hasMinRole(ctx.role, 'admin')
    return NextResponse.json(
      { connection: toPublicConnection(created, { userId: ctx.userId, isAdmin }) },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
