// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template through the
//                        account's transport (phone-variant retry,
//                        provider pacing), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import {
  loadAccountTransport,
  TransportNotConfiguredError,
  type WhatsAppTransport,
} from '@/lib/whatsapp/transport';
import {
  sendBroadcastRecipient,
  type RecipientSendContext,
} from '@/lib/whatsapp/broadcast-attempts';
import { paceBroadcastSend, type PaceOptions } from '@/lib/whatsapp/transport/pacing';
import {
  HEADER_TEXT_REQUIRED_MESSAGE,
  parseApiTemplateParams,
  resolveTemplateRow,
  templateHeaderTextMissing,
  templateUsableOn,
} from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /**
   * Positional body params for the template ({{1}}, {{2}}…), or the
   * structured form `{ body?: string[], headerText?: string }` when the
   * template's header has a variable (see parseApiTemplateParams).
   */
  params?: unknown;
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
  /** Value for a TEXT header {{1}}, when the template has one. */
  headerText?: string;
}

export interface BroadcastPlan {
  /** Tenancy key — also the pacing key between sends. */
  accountId: string;
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  /** The account's active WhatsApp transport, resolved at plan time. */
  transport: WhatsAppTransport;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // The account's WhatsApp transport — fail fast before anything is
  // persisted when there is no usable connection.
  const transport = await loadBroadcastTransport(db, accountId);

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;
  if (!templateUsableOn(transport.capabilities.templates, templateRow)) {
    throw new BroadcastError(
      'template_not_approved',
      'This template’s current version is not approved by Meta (local, draft or in review) — submit it and wait for approval.',
      400
    );
  }

  // Params shape and a header {{1}} without a value are caller errors
  // for the whole request — answered before any contact or row exists.
  const parsedParams = recipients.map((r) => parseApiTemplateParams(r?.params));
  const malformedAt = parsedParams.findIndex((p) => p === null);
  if (malformedAt !== -1) {
    throw new BroadcastError(
      'bad_request',
      `recipients[${malformedAt}].params must be an array of strings or { body?: string[], headerText?: string }`,
      400
    );
  }
  const missingHeaderAt = parsedParams.findIndex((p) => templateHeaderTextMissing(templateRow, p));
  if (missingHeaderAt !== -1) {
    throw new BroadcastError(
      'template_header_param_required',
      `recipients[${missingHeaderAt}]: ${HEADER_TEXT_REQUIRED_MESSAGE}`,
      400
    );
  }

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  // `to` is raw integrator input, so the leading `+` is required — a
  // national-format number would otherwise be delivered to whichever
  // country its leading digits spell (issue #586).
  const resolved: { contactId: string; phone: string; params: string[]; headerText?: string }[] = [];
  let rejected = 0;
  for (const [index, r] of recipients.entries()) {
    const to = typeof r.to === 'string' ? r.to : '';
    const sanitized = parseInternationalPhone(to);
    if (!sanitized) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: to,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: parsedParams[index]!.body,
      ...(parsedParams[index]!.headerText ? { headerText: parsedParams[index]!.headerText } : {}),
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid international phone number (leading + and country code, e.g. +14155550123)',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}. Sent as
      // ONE JSON array (element i = recipient i's params); the RPC takes
      // JSONB since 055 — as JSONB[] PostgREST made it a 2-D array.
      // A header value is frozen with the body as the structured form;
      // without one the stored shape stays the plain array it always was.
      p_template_params: deduped.map((r) =>
        r.headerText ? { body: r.params, headerText: r.headerText } : r.params
      ),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return {
        recipientRowId: row.recipient_id,
        phone: r.phone,
        params: r.params,
        ...(r.headerText ? { headerText: r.headerText } : {}),
      };
    }
  );

  return {
    accountId,
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    transport,
    templateRow,
    planned,
    rejected,
  };
}

/**
 * Resolve the account's transport for a broadcast, mapping "nothing
 * configured" to the {@link BroadcastError} both create and resume
 * surface.
 */
export async function loadBroadcastTransport(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppTransport> {
  try {
    return await loadAccountTransport(db, accountId);
  } catch (err) {
    if (err instanceof TransportNotConfiguredError) {
      throw new BroadcastError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        400
      );
    }
    throw err;
  }
}

/** A pass that dies mid-way is picked up by the continuation after this. */
export const DEAD_MAN_MS = 10 * 60 * 1000;

/** A broadcast write the delivery depends on failed. */
export class BroadcastStoreError extends Error {
  constructor(step: string, cause?: { message?: string } | null) {
    super(`broadcast ${step} failed${cause?.message ? `: ${cause.message}` : ''}`);
    this.name = 'BroadcastStoreError';
  }
}

/**
 * When the continuation (cron) should look at this broadcast next; null
 * once nothing is left. Checked — a lost schedule strands recipients.
 */
export async function scheduleContinuation(
  db: SupabaseClient,
  broadcastId: string,
  at: number | null
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({ auto_resume_at: at === null ? null : new Date(at).toISOString() })
    .eq('id', broadcastId);
  if (error) throw new BroadcastStoreError('schedule', error);
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient through its
 * durable send attempt (broadcast-attempts.ts) and let the attempt
 * record the outcome. Best-effort per recipient — one failed send never
 * aborts the rest; a failed WRITE does (the pass stops, the schedule
 * set at its start brings the continuation back).
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * advances them automatically, and later delivery/read webhooks keep
 * advancing them. We therefore never write those columns here — only
 * the terminal `status` — otherwise a manual value would race and
 * clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan,
  opts: {
    /** Last moment a send may START (broadcastSendDeadline). */
    deadline?: number;
    /** Absolute moment every provider call must have finished
     *  (broadcastSendBy); the transports abort at it. */
    sendBy?: number;
    /** Clock / sleep / jitter injection for tests. */
    pace?: Omit<PaceOptions, 'deadline'>;
  } = {}
): Promise<{ attempted: number; deferred: number; interrupted: boolean }> {
  const now = opts.pace?.now ?? Date.now;
  let attempted = 0;
  let interrupted = false;
  let nextDue: number | null = null;
  const due = (at: number) => {
    nextDue = nextDue === null ? at : Math.min(nextDue, at);
  };

  // Dead-man switch: if this pass dies, the continuation comes back.
  await scheduleContinuation(db, plan.broadcastId, now() + DEAD_MAN_MS);

  const ctx: RecipientSendContext = {
    accountId: plan.accountId,
    transport: plan.transport,
    sendBy: opts.sendBy,
    now,
    pace: () =>
      paceBroadcastSend(plan.accountId, plan.transport.capabilities.broadcastDelayMs, {
        ...opts.pace,
        deadline: opts.deadline,
      }),
  };

  for (const recipient of plan.planned) {
    // A header {{1}} without a value (a row frozen before the template
    // gained one, resumed later): never send a literal {{1}} (QR) or a
    // request Meta rejects — fail the recipient before any attempt.
    if (templateHeaderTextMissing(plan.templateRow, { headerText: recipient.headerText })) {
      const { error } = await db
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: HEADER_TEXT_REQUIRED_MESSAGE })
        .eq('id', recipient.recipientRowId)
        .eq('status', 'pending');
      if (error) throw new BroadcastStoreError('recipient update', error);
      attempted++;
      continue;
    }

    const { result, stop } = await sendBroadcastRecipient(db, ctx, recipient.recipientRowId, {
      to: recipient.phone,
      templateName: plan.templateName,
      language: plan.templateLanguage,
      template: plan.templateRow,
      params: recipient.params,
      ...(recipient.headerText ? { messageParams: { headerText: recipient.headerText } } : {}),
    });
    if (result.status === 'deferred') {
      due(now());
    } else {
      attempted++;
      if (result.status === 'pending') due(result.retryAt);
    }
    if (stop) {
      interrupted = result.status !== 'deferred';
      due(now());
      break;
    }
  }

  const finished = await finalizeBroadcastStatus(db, plan.broadcastId);
  // Recipients still pending (out of budget, backoff, a resendable
  // unknown): the cron continuation picks the broadcast up when due — no
  // manual Resume needed. Nothing pending: no schedule.
  await scheduleContinuation(
    db,
    plan.broadcastId,
    finished ? null : (nextDue ?? now())
  );
  const deferred = plan.planned.length - attempted;
  return { attempted, deferred, interrupted };
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 * Returns true when it did (nothing pending), false when work remains.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached the provider is
 * `sent`, with the per-recipient failures visible in `failed_count` and
 * unconfirmed ones (`unknown`) awaiting a decision on the detail page.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<boolean> {
  const countWhere = async (status: string | null): Promise<number> => {
    let q = db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId);
    if (status) q = q.eq('status', status);
    const { count, error } = await q;
    if (error) throw new BroadcastStoreError('recipient count', error);
    return count ?? 0;
  };

  // Still work outstanding — leave it 'sending'.
  if ((await countWhere('pending')) > 0) return false;

  const failed = await countWhere('failed');
  const total = await countWhere(null);

  const { error } = await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === total ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId)
    .eq('status', 'sending');
  if (error) throw new BroadcastStoreError('status', error);
  return true;
}
