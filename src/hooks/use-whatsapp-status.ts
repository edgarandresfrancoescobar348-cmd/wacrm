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
      setRow((data as WhatsAppStatusRow | null) ?? null);
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
