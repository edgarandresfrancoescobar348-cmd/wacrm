'use client';

import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import {
  CONNECTION_POLL_MS,
  connectionNotice,
  type ConnectionNotice,
  type WhatsAppStatusRow,
} from '@/lib/whatsapp/connection-status';

/**
 * The account's active WhatsApp connection, kept current while the page
 * is open: re-read every CONNECTION_POLL_MS, when the tab regains focus
 * and when it becomes visible. A page opened before the QR code was
 * scanned (or before a session dropped) no longer shows a stale state.
 */
export function useWhatsAppStatus(accountId: string | null | undefined): ConnectionNotice & {
  connected: boolean | null;
} {
  const [row, setRow] = useState<WhatsAppStatusRow | null | undefined>(undefined);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    const read = async () => {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('status, provider')
        .eq('account_id', accountId)
        .maybeSingle();
      if (cancelled || error) return; // keep the last known state on a failed read
      const current = (data as WhatsAppStatusRow | null) ?? null;
      setRow(current);
      // QR mode says disconnected: have the server check the gateway (a
      // late, stale event can leave the row behind a session that is
      // back) and re-read if it corrected it.
      if (current?.provider === 'openwa' && current.status !== 'connected') {
        const res = await fetch('/api/whatsapp/openwa?verify=1', { cache: 'no-store' }).catch(() => null);
        const body = res?.ok ? ((await res.json()) as { openwa?: { status?: string } }) : null;
        if (!cancelled && body?.openwa?.status === 'ready') setRow({ ...current, status: 'connected' });
      }
    };
    void read();
    const timer = setInterval(read, CONNECTION_POLL_MS);
    const onWake = () => {
      if (document.visibilityState === 'visible') void read();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [accountId]);

  const notice = connectionNotice(row);
  return { ...notice, connected: row === undefined ? null : notice.kind === null };
}
