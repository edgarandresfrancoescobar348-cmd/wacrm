// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Keyset-paginated (newest first). Filters: `?status=` (open/pending/
// closed), `?contact_id=` and `?connection_id=`. Each conversation
// embeds its contact + tags via the shared CONVERSATION_SELECT. Only the
// account's business numbers: a personal number's conversations are its
// owner's alone (phase 6) and an API key is the account's.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
  isUuid,
} from '@/lib/api/v1/pagination';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';
import { businessConnectionIds, NO_CONNECTION } from '@/lib/whatsapp/connections';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');
    if (contactId && !isUuid(contactId)) {
      return fail('bad_request', "'contact_id' must be a contact id (UUID)", 400);
    }
    const connectionId = url.searchParams.get('connection_id');
    const business = await businessConnectionIds(ctx.supabase, ctx.accountId);

    let query = ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('account_id', ctx.accountId)
      .in('connection_id', business.length ? business : [NO_CONNECTION])
      // WhatsApp groups (QR mode) are not CRM conversations (migration 080).
      .eq('is_group', false);

    if (status) query = query.eq('status', status);
    if (contactId) query = query.eq('contact_id', contactId);
    if (connectionId) query = query.eq('connection_id', connectionId);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/conversations] list error:', error);
      return fail('internal', 'Failed to list conversations', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) =>
        serializeConversation(normalizeConversation(r as Conversation))
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
