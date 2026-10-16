// ============================================================
// POST /api/v1/broadcasts — launch a template broadcast
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                 // optional label
//     "template_name": "promo_july",        // required, approved template
//     "template_language": "en_US",         // optional (default en_US)
//     "recipients": [                        // required, 1..1000
//       { "to": "+14155550123", "params": ["Jane"] },
//       { "to": "+14155550124" },
//       // structured, when the template header has a {{1}} (required then):
//       { "to": "+14155550125", "params": { "body": ["Ana"], "headerText": "#101" } }
//     ]
//   }
//
// The broadcast + its recipient rows are persisted synchronously, then
// the Meta fan-out runs in `after()` so the request returns fast. Poll
// `GET /api/v1/broadcasts/{id}` for progress.
//
// Response (202):
//   { "data": { "broadcast_id", "status": "sending",
//               "total_recipients", "accepted", "rejected" } }
// ============================================================

import { after } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';

// The `after()` fan-out below sends sequentially within this route's max
// duration. It is bounded by that budget (broadcastSendDeadline): what
// doesn't fit — a large audience, or any audience on a paced QR-code
// connection — is left `pending` with the broadcast still `sending`,
// and Resume continues from there. A send is never cut off mid-way.
export const maxDuration = 300;
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  broadcastSendBy,
  broadcastSendDeadline,
  estimatePassCapacity,
} from '@/lib/whatsapp/transport/pacing';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  createBroadcast,
  deliverBroadcast,
  BroadcastError,
} from '@/lib/whatsapp/broadcast-core';

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const plan = await createBroadcast(ctx.supabase, ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : null,
      recipients: recipients.map((r) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        // Array (body) or { body, headerText } — validated in createBroadcast.
        params: r?.params,
      })),
    });

    // Fan out after the response is sent. Uses the same service-role
    // client — no request-scoped auth needed for the Meta calls or
    // the account-scoped row updates.
    // Bounded by this invocation's budget: on a paced (QR) connection a
    // large audience can't finish in one handler — the recipients not
    // reached stay pending and the broadcast stays `sending`, ready for
    // Resume (dashboard) — never a handler killed mid-send.
    const deadline = broadcastSendDeadline(maxDuration, startedAt);
    const sendBy = broadcastSendBy(maxDuration, startedAt);
    after(() => deliverBroadcast(ctx.supabase, plan, { deadline, sendBy }));
    // What this first pass can reach; the rest continues automatically
    // on the next cron run (broadcast-continue.ts).
    const firstPass = estimatePassCapacity(plan, deadline, startedAt);

    return ok(
      {
        broadcast_id: plan.broadcastId,
        status: 'sending',
        total_recipients: plan.planned.length,
        accepted: plan.planned.length,
        rejected: plan.rejected,
        // Paced connections deliver in time-boxed passes; `remaining`
        // recipients are continued automatically by the scheduler.
        first_pass: firstPass,
        remaining: plan.planned.length - firstPass,
      },
      202
    );
  } catch (err) {
    if (err instanceof BroadcastError) {
      return fail(err.code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
