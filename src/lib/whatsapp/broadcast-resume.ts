// ============================================================
// Broadcast resume / retry (issue #472).
//
// The dashboard wizard drives its own send loop from the browser tab
// that started the campaign, so closing the tab abandons the campaign
// mid-flight: the remaining recipients stay 'pending' and the
// broadcast sits in 'sending' forever. This module is the recovery —
// and the same machinery answers the reporter's other two asks,
// "reprocess pending" and "reprocess failed".
//
// It deliberately reuses `deliverBroadcast` rather than growing a
// second fan-out loop: same phone-variant retry, same per-recipient
// stamping, same trigger-owned counts.
//
// What it does NOT do is move the *initial* send server-side. The
// wizard still owns that; this makes an abandoned one recoverable.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BroadcastError,
  loadBroadcastTransport,
  type BroadcastPlan,
} from '@/lib/whatsapp/broadcast-core';
import { chunk } from '@/lib/supabase/paged-query';
import { parseApiTemplateParams, resolveTemplateRow, templateUsableOn } from '@/lib/whatsapp/template-body';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

/** Which recipients a resume pass picks up. */
export type ResumeScope = 'pending' | 'failed' | 'all';

export const RESUME_SCOPES: readonly ResumeScope[] = [
  'pending',
  'failed',
  'all',
];

/**
 * Recipients delivered per resume request. One pass runs inside
 * `after()`, so it is bounded by the host's function timeout — the cap
 * keeps a 5 000-recipient backlog from being one un-completable unit
 * of work. Whatever is left stays 'pending' and the caller is told how
 * many, so the UI can offer Resume again. Matches the public API's
 * per-request recipient cap.
 */
export const RESUME_MAX_PER_REQUEST = 1000;

export const RESUME_MAX_SCAN_PAGES = 25;

/**
 * How long a `delivery_locked_at` stamp is honoured before it is read
 * as abandoned. Long enough that a legitimately slow pass is never
 * stolen from, short enough that a crashed one doesn't wedge the
 * campaign until someone touches the database.
 */
export const DELIVERY_LOCK_STALE_MS = 30 * 60 * 1000;

function scopeStatuses(scope: ResumeScope): string[] {
  if (scope === 'pending') return ['pending'];
  if (scope === 'failed') return ['failed'];
  return ['pending', 'failed'];
}

/**
 * Take the delivery lock for a broadcast.
 *
 * One conditional UPDATE, so the claim is atomic: a concurrent caller's
 * WHERE no longer matches and it gets `false`. Returns false when the
 * broadcast doesn't exist on this account, too — the caller treats both
 * as "not yours to run".
 */
export async function claimBroadcastDelivery(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  now: Date = new Date()
): Promise<boolean> {
  const staleCutoff = new Date(
    now.getTime() - DELIVERY_LOCK_STALE_MS
  ).toISOString();

  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: now.toISOString() })
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`)
    .select('id');

  if (error) {
    console.error('[broadcast-resume] claim failed:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/** Release the delivery lock. Best-effort; a stale lock self-expires. */
export async function releaseBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: null })
    .eq('id', broadcastId);
  if (error) {
    console.error('[broadcast-resume] release failed:', error.message);
  }
}

export interface ResumePlan {
  plan: BroadcastPlan;
  /** In-scope recipients left over after the per-request cap. */
  remaining: number;
  /**
   * In-scope rows that can never send because their contact has no
   * usable phone. Stamped 'failed' by {@link planBroadcastResume} so
   * they stop blocking the broadcast's terminal status.
   */
  unsendable: number;
}

interface RecipientRow {
  id: string;
  status?: string;
  template_params: unknown;
  contact: { phone?: string | null } | { phone?: string | null }[] | null;
}

/** Supabase renders an embedded to-one join as an object or a 1-array. */
function contactPhone(row: RecipientRow): string | null {
  const c = Array.isArray(row.contact) ? row.contact[0] : row.contact;
  return c?.phone ?? null;
}

/**
 * Build a {@link BroadcastPlan} for the recipients of an existing
 * broadcast that still need sending.
 *
 * Params come off the recipient rows (frozen at plan time by migration
 * 038) rather than being re-resolved from contact data, so a resume
 * sends what the original pass would have sent even if the contact has
 * been edited since.
 *
 * Throws {@link BroadcastError}; the route maps it.
 */
export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope
): Promise<ResumePlan> {
  const { data: broadcast, error: bcError } = await db
    .from('broadcasts')
    .select('id, template_name, template_language, connection_id')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (bcError || !broadcast) {
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  }

  const statuses = scopeStatuses(scope);
  // The number it went out from (phase 6) — the same one resumes it.
  const { transport, connectionId } = await loadBroadcastTransport(db, accountId, broadcast.connection_id);

  const sendable: RecipientRow[] = [];
  const unsendable: string[] = [];
  let inScopeCount: number | null = null;
  let scanned = 0;

  for (
    let page = 0;
    page < RESUME_MAX_SCAN_PAGES && sendable.length < RESUME_MAX_PER_REQUEST;
    page++
  ) {
    const from = page * RESUME_MAX_PER_REQUEST;
    const {
      data: rawRows,
      count,
      error: recError,
    } = await db
      .from('broadcast_recipients')
      .select('id, status, template_params, contact:contacts(phone)', { count: 'exact' })
      .eq('broadcast_id', broadcastId)
      .in('status', statuses)
      // Oldest first, so repeated capped passes chew through the backlog
      // in a stable order instead of re-picking the same slice.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + RESUME_MAX_PER_REQUEST - 1);

    if (recError) {
      console.error('[broadcast-resume] recipient load failed:', recError.message);
      throw new BroadcastError('internal', 'Failed to load recipients', 500);
    }

    const rows = (rawRows ?? []) as RecipientRow[];
    if (page === 0) inScopeCount = count ?? null;
    scanned += rows.length;

    // A recipient whose contact has no usable phone can never send. Stamp
    // it failed now: leaving it 'pending' would keep the broadcast in
    // 'sending' forever, which is the very symptom being fixed.
    // (A recipient interrupted mid-send is NOT decided here any more: its
    // send attempt is reconciled — or put up for a decision — when its
    // turn comes; see broadcast-attempts.ts.)
    for (const row of rows) {
      const sanitized = sanitizePhoneForMeta(contactPhone(row) ?? '');
      if (isValidE164(sanitized)) sendable.push(row);
      else unsendable.push(row.id);
    }

    if (rows.length < RESUME_MAX_PER_REQUEST) break;
  }

  for (const ids of chunk(unsendable)) {
    const { error } = await db
      .from('broadcast_recipients')
      .update({
        status: 'failed',
        error_message: 'No valid phone number on contact',
      })
      .in('id', ids);
    if (error) throw new BroadcastError('internal', 'Failed to update recipients', 500);
  }

  const slice = sendable.slice(0, RESUME_MAX_PER_REQUEST);
  const unloaded = Math.max(0, (inScopeCount ?? scanned) - scanned);
  const remaining = sendable.length - slice.length + unloaded;

  if (slice.length === 0 && remaining === 0) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope === 'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400
    );
  }

  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    broadcast.template_name,
    broadcast.template_language
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before resuming.',
      500
    );
  }

  if (!templateUsableOn(transport.capabilities.templates, resolvedTemplate.row)) {
    throw new BroadcastError(
      'template_not_approved',
      'This template’s current version is not approved by Meta (local, draft or in review) — submit it and wait for approval.',
      400
    );
  }

  // Retrying failed recipients: they become `pending` NOW, in one
  // statement, so a pass interrupted halfway leaves them resumable for
  // the continuation instead of stranded as `failed` (H7). Each gets a
  // new send attempt (new key) when its turn comes — the previous one is
  // known failed.
  const retried = slice.filter((row) => row.status === 'failed').map((row) => row.id);
  for (const ids of chunk(retried)) {
    const { error } = await db.rpc('broadcast_retry_failed', {
      p_account_id: accountId,
      p_broadcast_id: broadcastId,
      p_recipient_ids: ids,
    });
    if (error) {
      console.error('[broadcast-resume] retry failed:', error.message);
      throw new BroadcastError('internal', 'Failed to queue the retry', 500);
    }
  }

  const plan: BroadcastPlan = {
    accountId,
    connectionId,
    broadcastId,
    templateName: broadcast.template_name,
    templateLanguage: resolvedTemplate.language,
    transport,
    templateRow: resolvedTemplate.row,
    planned: slice.map((row) => ({
      recipientRowId: row.id,
      phone: sanitizePhoneForMeta(contactPhone(row) ?? ''),
      // Frozen as a plain array, or as { body, headerText } when the
      // template's header has a variable (v1 broadcasts).
      ...frozenParams(row.template_params),
    })),
    rejected: 0,
  };

  return { plan, remaining, unsendable: unsendable.length };
}

/**
 * Put the broadcast back into `sending` for the duration of the pass,
 * so the detail page reads as in-flight rather than as a finished
 * campaign that is quietly still working.
 */
export async function markBroadcastSending(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', broadcastId);
  if (error) throw new BroadcastError('internal', 'Failed to mark the broadcast sending', 500);
}

function frozenParams(value: unknown): { params: string[]; headerText?: string } {
  if (Array.isArray(value)) {
    return { params: value.filter((p): p is string => typeof p === 'string') };
  }
  const parsed = parseApiTemplateParams(value);
  return parsed
    ? { params: parsed.body, ...(parsed.headerText ? { headerText: parsed.headerText } : {}) }
    : { params: [] };
}
