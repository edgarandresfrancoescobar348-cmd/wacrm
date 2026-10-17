'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';

import type { PublicConnection } from '@/lib/whatsapp/connections';
import { CONNECTION_POLL_MS, connectionNotice, type ConnectionNotice } from '@/lib/whatsapp/connection-status';

export interface ConnectionView extends PublicConnection {
  can_operate: boolean;
  can_disconnect: boolean;
  /** May the viewer move it to Pessoal / to Empresa (phase 6b)? */
  can_make_personal?: boolean;
  can_make_business?: boolean;
}

export interface CanAdd {
  official: boolean;
  business_qr: boolean;
  personal_qr: boolean;
}

interface State {
  connections: ConnectionView[] | undefined;
  canAdd: CanAdd | null;
}

/**
 * One realtime subscription per account topic, shared by every mounted
 * user of the hook (the client hands back the same channel for a topic
 * and refuses callbacks added after subscribe()).
 */
const numberListeners = new Map<string, { listeners: Set<() => void>; stop: () => void }>();

function onNumbersChanged(accountId: string, listener: () => void): () => void {
  let entry = numberListeners.get(accountId);
  if (!entry) {
    const listeners = new Set<() => void>();
    const supabase = createClient();
    const channel = supabase
      .channel(`numbers:${accountId}`)
      .on('broadcast', { event: 'changed' }, () => listeners.forEach((l) => l()))
      .subscribe();
    entry = { listeners, stop: () => void supabase.removeChannel(channel) };
    numberListeners.set(accountId, entry);
  }
  entry.listeners.add(listener);
  return () => {
    const current = numberListeners.get(accountId);
    if (!current) return;
    current.listeners.delete(listener);
    if (!current.listeners.size) {
      current.stop();
      numberListeners.delete(accountId);
    }
  };
}

async function fetchConnections(): Promise<{ connections: ConnectionView[]; can_add: CanAdd } | null> {
  const res = await fetch('/api/whatsapp/connections', { cache: 'no-store' }).catch(() => null);
  return res?.ok ? ((await res.json()) as { connections: ConnectionView[]; can_add: CanAdd }) : null;
}

/**
 * The account's WhatsApp numbers (phase 6) as the viewer sees them, kept
 * current while the page is open: re-read every CONNECTION_POLL_MS, when
 * the tab regains focus and when it becomes visible. A QR number the row
 * says is down is checked against the gateway (a late, stale event can
 * leave it behind a session that is back) and re-read when corrected.
 *
 * A number moving between Pessoal and Empresa (phase 6b) is announced on
 * the account's realtime topic `numbers:<accountId>` (connection-scope.ts):
 * the list is re-read at once, not on the next poll.
 *
 * `connections` is undefined while loading; `notice` speaks about the
 * numbers the viewer sees (connection-status.ts).
 */
export function useWhatsAppConnections(opts: { poll?: boolean } = {}): State & {
  notice: ConnectionNotice;
  reload: () => Promise<void>;
} {
  const poll = opts.poll !== false;
  const [state, setState] = useState<State>({ connections: undefined, canAdd: null });

  const reload = useCallback(async () => {
    const data = await fetchConnections();
    if (data) setState({ connections: data.connections, canAdd: data.can_add });
  }, []);

  const accountId = useAuth().profile?.account_id ?? null;
  useEffect(() => {
    if (!accountId) return;
    return onNumbersChanged(accountId, () => void reload());
  }, [accountId, reload]);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const data = await fetchConnections();
      if (cancelled || !data) return; // keep the last known state on a failed read
      setState({ connections: data.connections, canAdd: data.can_add });
      const stale = data.connections.filter((c) => c.visible && c.provider === 'openwa' && c.status !== 'connected');
      if (!stale.length) return;
      const checked = await Promise.all(
        stale.map((c) =>
          fetch(`/api/whatsapp/openwa?connection_id=${c.id}&verify=1`, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null) as Promise<{ openwa?: { status?: string } } | null>,
        ),
      );
      if (!cancelled && checked.some((b) => b?.openwa?.status === 'ready')) {
        const again = await fetchConnections();
        if (!cancelled && again) setState({ connections: again.connections, canAdd: again.can_add });
      }
    };
    void read();
    if (!poll) {
      return () => {
        cancelled = true;
      };
    }
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
  }, [poll]);

  return { ...state, notice: connectionNotice(state.connections), reload };
}
