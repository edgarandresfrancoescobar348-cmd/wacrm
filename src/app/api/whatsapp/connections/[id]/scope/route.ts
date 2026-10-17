// /api/whatsapp/connections/[id]/scope — Pessoal or Empresa (phase 6b).
//
//   GET   what the confirmation says before a change: may the caller
//         make it personal / the team's, how many conversations change
//         sides, how many carry a name from the phone's address book, and
//         (for an admin turning a business number personal) the members
//         who may own it.
//   POST  { scope: 'personal' | 'business', owner_user_id? } — the change
//         (connection-scope.ts; set_connection_scope checks it again):
//         Empresa → Pessoal an admin, for a member (default: themself);
//         Pessoal → Empresa only that number's owner. Never the official
//         number.

import { NextResponse, after } from 'next/server'

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { requireConnection, scopeChoices } from '@/lib/whatsapp/connection-access'
import { changeConnectionScope, movePublicMediaPrivate, ScopeChangeError } from '@/lib/whatsapp/connection-scope'
import type { AccountContext } from '@/lib/auth/account'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { ctx, connection } = await requireConnection(id, 'view')
    const choices = scopeChoices(connection, ctx)
    if (!choices.can_make_personal && !choices.can_make_business) {
      return NextResponse.json({ scope: connection.scope, ...choices })
    }
    const admin = supabaseAdmin()
    const [{ count: conversations }, { count: savedNames }] = await Promise.all([
      admin.from('conversations').select('id', { count: 'exact', head: true }).eq('connection_id', connection.id),
      admin
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('connection_id', connection.id)
        .not('saved_name', 'is', null),
    ])
    let members: { user_id: string; name: string }[] = []
    if (choices.can_make_personal) {
      const { data } = await admin
        .from('profiles')
        .select('user_id, full_name, account_role')
        .eq('account_id', ctx.accountId)
        .order('full_name')
      members = ((data ?? []) as { user_id: string; full_name: string | null; account_role: string }[])
        // Who may own a personal number: who may add one (an agent or more).
        .filter((p) => hasMinRole(p.account_role as AccountContext['role'], 'agent'))
        .map((p) => ({ user_id: p.user_id, name: p.full_name || '—' }))
    }
    return NextResponse.json({
      scope: connection.scope,
      ...choices,
      conversations: conversations ?? 0,
      saved_names: choices.can_make_business ? (savedNames ?? 0) : 0,
      members,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { ctx, connection } = await requireConnection(id, 'view')
    const limit = checkRateLimit(`openwa-admin:${ctx.userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    const body = (await request.json().catch(() => ({}))) as { scope?: unknown; owner_user_id?: unknown }
    if (body.scope !== 'personal' && body.scope !== 'business') {
      return NextResponse.json({ error: "scope must be 'personal' or 'business'", field: 'scope' }, { status: 400 })
    }
    const owner =
      body.scope === 'personal' && typeof body.owner_user_id === 'string' && body.owner_user_id ? body.owner_user_id : null
    if (owner && !/^[0-9a-f-]{36}$/i.test(owner)) {
      return NextResponse.json({ error: 'owner_user_id must be a member id', field: 'owner_user_id' }, { status: 400 })
    }
    if (connection.scope === body.scope && (body.scope === 'business' || (owner ?? ctx.userId) === connection.ownerUserId)) {
      return NextResponse.json({ changed: false, scope: connection.scope, owner_user_id: connection.ownerUserId })
    }
    const choices = scopeChoices(connection, ctx)
    if (body.scope === 'personal' ? !choices.can_make_personal : !choices.can_make_business) throw new ForbiddenError()
    const admin = supabaseAdmin()
    if (owner && owner !== ctx.userId) {
      const { data: member } = await admin
        .from('profiles')
        .select('account_role')
        .eq('account_id', ctx.accountId)
        .eq('user_id', owner)
        .maybeSingle()
      if (!member || !hasMinRole((member as { account_role: AccountContext['role'] }).account_role, 'agent')) {
        return NextResponse.json({ error: 'The owner must be a member who may have a personal number', field: 'owner_user_id' }, { status: 400 })
      }
    }
    try {
      const result = await changeConnectionScope(admin, connection, {
        scope: body.scope,
        ownerUserId: owner,
        actorUserId: ctx.userId,
      })
      // Its public files go private right after the answer (connection-scope.ts).
      if (result.scope === 'personal') {
        after(() =>
          movePublicMediaPrivate(admin, connection.id).catch((err) =>
            console.warn('[numbers] media move failed:', err instanceof Error ? err.message : err),
          ),
        )
      }
      return NextResponse.json(result)
    } catch (err) {
      if (err instanceof ScopeChangeError) return NextResponse.json({ error: err.message }, { status: err.status })
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
