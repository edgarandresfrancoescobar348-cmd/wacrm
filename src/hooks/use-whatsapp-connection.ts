'use client';

import { useEffect, useState } from 'react';

export interface WhatsAppConnectionInfo {
  /** Active connection, or null while loading / when none is set up. */
  provider: 'meta' | 'openwa' | null;
  /** QR-code mode's minimum gap between broadcast sends, in ms. */
  broadcastDelayMs: number | null;
  loading: boolean;
}

/**
 * The account's active WhatsApp connection mode, for UI that differs
 * between the official API and a QR-code (OpenWA) number — the 24h
 * window, Meta template approval, broadcast pacing. Reads the sanitized
 * `/api/whatsapp/openwa` state (no secrets).
 */
export function useWhatsAppConnection(): WhatsAppConnectionInfo {
  const [info, setInfo] = useState<WhatsAppConnectionInfo>({
    provider: null,
    broadcastDelayMs: null,
    loading: true,
  });
  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/openwa', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setInfo({
          provider: data?.provider ?? null,
          broadcastDelayMs: data?.openwa?.broadcast_delay_ms ?? null,
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setInfo((prev) => ({ ...prev, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
