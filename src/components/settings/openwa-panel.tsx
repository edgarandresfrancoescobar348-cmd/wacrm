'use client';

import { OpenWaHistoryImport } from './openwa-history-import';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  KeyRound,
  Loader2,
  LogOut,
  QrCode,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Smartphone,
  XCircle,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import type { ConnectionView } from '@/hooks/use-whatsapp-connections';
import { formatDateTimeMedium } from '@/lib/locale-format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export type OpenWaStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed';

export interface OpenWaPublicState {
  configured: boolean;
  engine: string | null;
  session_id: string | null;
  status: OpenWaStatus | null;
  phone: string | null;
  push_name: string | null;
  last_error: string | null;
  restriction: { kind: string; code: string; expiresAt: string | null } | null;
  reconnect_attempts: number | null;
  status_updated_at: string | null;
  connected_at: string | null;
  broadcast_delay_ms: number | null;
  webhook_registered: boolean;
}

export type OpenWaGatewayState = 'ok' | 'unconfigured' | 'unreachable' | 'auth_failed' | 'error';

export interface OpenWaApiState {
  openwa: OpenWaPublicState;
  /** The embedded gateway, probed by `?gateway=1` (null when not asked). */
  gateway: { state: OpenWaGatewayState; engine: string | null } | null;
}

const POLL_MS = 3000;
const DEFAULT_DELAY_S = 8;
const POLLING_STATES: OpenWaStatus[] = ['initializing', 'qr_ready', 'authenticating'];

function formatPhone(digits: string | null): string {
  if (!digits) return '';
  return `+${digits}`;
}

/**
 * Settings → WhatsApp → one QR number (phase 6: an account may have
 * several, each Pessoal or Empresa). Connects a regular WhatsApp number
 * via the gateway that runs with wacrm (OpenWA, embedded — nothing to
 * configure): "Conectar" (session + signed webhook + start), the live QR
 * (refreshed every few seconds until it is scanned) or a pairing code,
 * and the connected state with "Desconectar" / "Reiniciar sessão". When
 * the gateway is down the card says so instead of offering "Conectar".
 * Only who may operate the number acts on it (a business number's admins,
 * a personal number's owner).
 */
export function OpenWaPanel({
  connection,
  onChanged,
}: {
  connection: ConnectionView;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('Settings.whatsapp.openwa');
  const locale = useLocale();
  const canEditSettings = connection.can_operate;
  const connectionId = connection.id;

  // This number's session state (+ a gateway probe).
  const [state, setState] = useState<OpenWaApiState | null>(null);
  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp/openwa?connection_id=${connectionId}&gateway=1`, { cache: 'no-store' });
      if (res.ok) setState((await res.json()) as OpenWaApiState);
    } catch {
      // keep the last known state
    }
  }, [connectionId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const refresh = useCallback(async () => {
    await reload();
    await onChanged();
  }, [reload, onChanged]);

  const openwa = state?.openwa ?? null;

  const [delayS, setDelayS] = useState(String(DEFAULT_DELAY_S));
  const hydratedRef = useRef(false);

  const [saving, setSaving] = useState(false);
  const [checkingGateway, setCheckingGateway] = useState(false);
  const [busy, setBusy] = useState<null | 'connect' | 'restart' | 'logout'>(null);

  const [status, setStatus] = useState<OpenWaStatus | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrUpdatedAt, setQrUpdatedAt] = useState<number | null>(null);
  const [live, setLive] = useState<OpenWaPublicState | null>(null);

  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingPhone, setPairingPhone] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);

  const [mirrorMedia, setMirrorMedia] = useState(connection.mirror_inbound_media);
  const [savingMirror, setSavingMirror] = useState(false);

  // Hydrate the form once per load of the server state.
  useEffect(() => {
    if (!state || hydratedRef.current) return;
    hydratedRef.current = true;
    setDelayS(
      String(
        state.openwa.broadcast_delay_ms
          ? Math.round(state.openwa.broadcast_delay_ms / 1000)
          : DEFAULT_DELAY_S,
      ),
    );
  }, [state]);

  useEffect(() => {
    if (!openwa) return;
    setLive(openwa);
    setStatus(openwa.status);
  }, [openwa]);

  // Media retention is the number's own setting (phase 6).
  useEffect(() => {
    setMirrorMedia(connection.mirror_inbound_media);
  }, [connection.mirror_inbound_media]);

  // ---- live QR / status polling ------------------------------------
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp/openwa/qr?connection_id=${connectionId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) return;
      setStatus(data.status ?? null);
      if (data.openwa) setLive(data.openwa);
      if (data.qr_code) {
        setQrCode((prev) => {
          if (prev !== data.qr_code) setQrUpdatedAt(Date.now());
          return data.qr_code;
        });
      } else if (data.status !== 'qr_ready') {
        setQrCode(null);
      }
      if (data.status === 'ready') {
        setPairingCode(null);
        void refresh();
      }
    } catch {
      // transient — next tick retries
    }
  }, [refresh, connectionId]);

  // A linked number shown disconnected is usually the gateway restoring it
  // after a restart (AUTO_START_SESSIONS): follow it until it is back.
  const restoring = status === 'disconnected' && !!live?.phone;
  const shouldPoll = canEditSettings && !!status && (POLLING_STATES.includes(status) || restoring);
  useEffect(() => {
    if (!shouldPoll) return;
    void poll();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [shouldPoll, poll]);

  // ---- actions --------------------------------------------------------
  async function handleSave(): Promise<boolean> {
    const seconds = Number(delayS);
    if (!Number.isFinite(seconds) || seconds < 3 || seconds > 120) {
      toast.error(t('delayInvalid'));
      return false;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/openwa', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId, broadcast_delay_ms: Math.round(seconds * 1000) }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('saveFailed'), { duration: 10000 });
        return false;
      }
      toast.success(t('saved'));
      setLive(data.openwa);
      await refresh();
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function sessionAction(action: 'connect' | 'restart' | 'logout') {
    if (action === 'logout' && !window.confirm(t('logoutConfirm'))) return;
    setBusy(action);
    try {
      const res = await fetch('/api/whatsapp/openwa/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Gateway down: re-probe so the card shows why, not just a toast.
        if (data.code === 'gateway_unavailable') {
          await refresh();
          return;
        }
        toast.error(data.error || t('actionFailed'), { duration: 10000 });
        return;
      }
      setLive(data.openwa);
      setStatus(data.openwa.status);
      setQrCode(null);
      if (action === 'logout') toast.success(t('loggedOut'));
      if (action === 'restart') toast.success(t('restarted'));
      await refresh();
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleCheckGateway() {
    setCheckingGateway(true);
    try {
      await refresh();
    } finally {
      setCheckingGateway(false);
    }
  }

  async function handlePairing() {
    setPairingBusy(true);
    setPairingCode(null);
    try {
      const res = await fetch('/api/whatsapp/openwa/pairing-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId, phone: pairingPhone }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('pairingFailed'), { duration: 10000 });
        return;
      }
      setPairingCode(data.pairing_code);
    } catch {
      toast.error(t('pairingFailed'));
    } finally {
      setPairingBusy(false);
    }
  }

  async function handleToggleMirror(next: boolean) {
    const previous = mirrorMedia;
    setMirrorMedia(next);
    setSavingMirror(true);
    const res = await fetch(`/api/whatsapp/connections/${connectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mirror_inbound_media: next }),
    }).catch(() => null);
    setSavingMirror(false);
    if (!res?.ok) {
      setMirrorMedia(previous);
      toast.error(t('mirrorSaveFailed'));
      return;
    }
    await onChanged();
  }

  // ---- render ---------------------------------------------------------
  const current = live ?? openwa;
  const restriction = current?.restriction ?? null;
  const loadingState = !state;
  const gatewayState = state?.gateway?.state ?? 'ok';
  const engineInUse = state?.gateway?.engine ?? current?.engine ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        {restriction && (
          <div role="alert" className="flex items-start gap-3 rounded-xl bg-destructive/10 p-4">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-destructive">{t('restrictionTitle')}</p>
              <p className="mt-1 text-muted-foreground">
                {t('restrictionDesc', { kind: restriction.kind })}
                {restriction.expiresAt
                  ? ' ' + t('restrictionUntil', { date: formatDateTimeMedium(restriction.expiresAt, locale) })
                  : ''}
              </p>
            </div>
          </div>
        )}

        {/* Connection card — driven by the session status */}
        <section aria-labelledby="openwa-connection" className="rounded-xl bg-surface p-4 sm:p-6">
          <h3 id="openwa-connection" className="mb-4 flex items-center gap-2 text-[15px] font-medium text-foreground">
            <Smartphone className="size-4 text-muted-foreground" />
            {t('connectionTitle')}
          </h3>
          {loadingState ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t('loading')}
            </div>
          ) : gatewayState !== 'ok' ? (
            <GatewayDown
              state={gatewayState}
              checking={checkingGateway}
              onRetry={() => void handleCheckGateway()}
            />
          ) : (
            <ConnectionBody
              status={status}
              state={current}
              qrCode={qrCode}
              qrUpdatedAt={qrUpdatedAt}
              canEdit={canEditSettings}
              busy={busy}
              onConnect={() => sessionAction('connect')}
              onRestart={() => sessionAction('restart')}
              onLogout={() => sessionAction('logout')}
              pairing={{
                open: pairingOpen,
                setOpen: setPairingOpen,
                phone: pairingPhone,
                setPhone: setPairingPhone,
                code: pairingCode,
                busy: pairingBusy,
                request: handlePairing,
              }}
            />
          )}
        </section>

        {/* History import (A1) */}
        {openwa?.session_id ? (
          <OpenWaHistoryImport connectionId={connectionId} connected={status === 'ready'} canEdit={canEditSettings} />
        ) : null}

        {/* Broadcast pacing */}
        <section aria-labelledby="openwa-pacing" className="space-y-4 rounded-xl bg-surface p-4 sm:p-6">
          <h3 id="openwa-pacing" className="text-[15px] font-medium text-foreground">{t('pacingTitle')}</h3>
          <div className="space-y-2">
            <Label htmlFor="openwa-delay" className="text-muted-foreground">{t('delayLabel')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="openwa-delay"
                type="number"
                min={3}
                max={120}
                value={delayS}
                disabled={!canEditSettings}
                onChange={(e) => setDelayS(e.target.value)}
                className="w-32 bg-muted border-border text-foreground"
              />
              {canEditSettings && (
                <Button variant="outline" onClick={() => void handleSave()} disabled={saving}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {t('save')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t('delayHint')}</p>
          </div>
        </section>

        {/* Engine — deployment-wide on the gateway */}
        <section aria-labelledby="openwa-engine" className="rounded-xl bg-surface p-4 sm:p-6">
          <h3 id="openwa-engine" className="text-[15px] font-medium text-foreground">{t('engineTitle')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('engineDesc')}</p>
          <div role="radiogroup" aria-label={t('engineTitle')} className="mt-3 overflow-hidden rounded-xl bg-hover-surface/60">
            {(['whatsapp-web.js', 'baileys'] as const).map((engine) => {
              const detected = engineInUse === engine;
              return (
                <div
                  key={engine}
                  role="radio"
                  aria-checked={detected}
                  aria-disabled
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                      detected ? 'border-primary' : 'border-muted-foreground',
                    )}
                  >
                    {detected && <span className="size-2.5 rounded-full bg-primary" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground">
                      {engine === 'whatsapp-web.js' ? t('engineWwebjs') : t('engineBaileys')}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {engine === 'whatsapp-web.js' ? t('engineWwebjsHint') : t('engineBaileysHint')}
                    </span>
                  </span>
                  {detected && <span className="text-[13px] text-primary-text">{t('engineDetected')}</span>}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t('engineSwitchHint')}</p>
        </section>

        {/* Media retention — this number's own setting */}
        <section className="flex items-start justify-between gap-4 rounded-xl bg-surface p-4 sm:p-6">
          <div className="min-w-0">
            <p className="text-[15px] text-foreground">{t('mirrorTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('mirrorDesc')}</p>
          </div>
          <Switch
            checked={mirrorMedia}
            disabled={!canEditSettings || savingMirror}
            onCheckedChange={(v) => void handleToggleMirror(v)}
            aria-label={t('mirrorTitle')}
          />
        </section>
      </div>

      {/* Side column */}
      <aside className="space-y-4">
        <div className="rounded-xl bg-amber-500/10 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="size-4" />
            {t('banTitle')}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{t('banDedicated')}</li>
            <li>{t('banNoCold')}</li>
            <li>{t('banPacing')}</li>
            <li>{t('banUnofficial')}</li>
          </ul>
        </div>
        <div className="rounded-xl bg-surface p-4 text-sm">
          <p className="font-medium text-foreground">{t('howTitle')}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{t('howTemplates')}</li>
            <li>{t('howMenus')}</li>
            <li>{t('howWindow')}</li>
            <li>{t('howGroups')}</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function ConnectionBody({
  status,
  state,
  qrCode,
  qrUpdatedAt,
  canEdit,
  busy,
  onConnect,
  onRestart,
  onLogout,
  pairing,
}: {
  status: OpenWaStatus | null;
  state: OpenWaPublicState | null;
  qrCode: string | null;
  qrUpdatedAt: number | null;
  canEdit: boolean;
  busy: null | 'connect' | 'restart' | 'logout';
  onConnect: () => void;
  onRestart: () => void;
  onLogout: () => void;
  pairing: {
    open: boolean;
    setOpen: (v: boolean) => void;
    phone: string;
    setPhone: (v: string) => void;
    code: string | null;
    busy: boolean;
    request: () => void;
  };
}) {
  const t = useTranslations('Settings.whatsapp.openwa');
  const locale = useLocale();

  if (!state?.configured) {
    return (
      <div className="space-y-3">
        <StatusLine tone="muted" icon={<QrCode className="size-4" />} text={t('statusNotConfigured')} />
        <p className="text-sm text-muted-foreground">{t('notConfiguredDesc')}</p>
        {canEdit && (
          <Button onClick={onConnect} disabled={busy !== null}>
            {busy === 'connect' && <Loader2 className="size-4 animate-spin" />}
            {t('connect')}
          </Button>
        )}
      </div>
    );
  }

  if (status === 'ready') {
    return (
      <div className="space-y-4">
        <StatusLine tone="ok" icon={<CheckCircle2 className="size-4" />} text={t('statusReady')} />
        <dl className="grid grid-cols-1 gap-3 rounded-lg bg-hover-surface/60 p-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">{t('phone')}</dt>
            <dd className="text-foreground">{formatPhone(state.phone) || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('pushName')}</dt>
            <dd className="text-foreground">{state.push_name || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('since')}</dt>
            <dd className="text-foreground">
              {state.connected_at ? formatDateTimeMedium(state.connected_at, locale) : '—'}
            </dd>
          </div>
        </dl>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onRestart} disabled={busy !== null}>
              {busy === 'restart' ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              {t('restart')}
            </Button>
            <Button variant="destructive" onClick={onLogout} disabled={busy !== null}>
              {busy === 'logout' ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
              {t('disconnect')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (status === 'qr_ready') {
    return (
      <div className="space-y-4">
        <StatusLine tone="wait" icon={<QrCode className="size-4" />} text={t('statusQr')} />
        <div className="flex flex-col gap-4">
          <div className="flex size-[232px] shrink-0 items-center justify-center rounded-xl bg-white p-2">
            {qrCode ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URL from the gateway
              <img src={qrCode} alt={t('qrAlt')} className="size-full" data-testid="openwa-qr" />
            ) : (
              <Loader2 className="size-6 animate-spin text-neutral-500" />
            )}
          </div>
          <div className="min-w-0 space-y-2 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-foreground">
              <li>{t('scanStep1')}</li>
              <li>{t('scanStep2')}</li>
              <li>{t('scanStep3')}</li>
            </ol>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="size-3" />
              {qrUpdatedAt
                ? t('qrRefreshing', { time: new Date(qrUpdatedAt).toLocaleTimeString(locale) })
                : t('qrWaiting')}
            </p>
          </div>
        </div>

        <div className="rounded-lg bg-hover-surface/60 p-3">
          <button
            type="button"
            onClick={() => pairing.setOpen(!pairing.open)}
            className="flex items-center gap-2 text-sm text-primary-text hover:underline"
          >
            <KeyRound className="size-4" />
            {t('usePairing')}
          </button>
          {pairing.open && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">{t('pairingDesc')}</p>
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label={t('pairingPhone')}
                  placeholder="+55 11 99999-9999"
                  value={pairing.phone}
                  onChange={(e) => pairing.setPhone(e.target.value)}
                  className="w-56 bg-muted border-border text-foreground"
                />
                <Button variant="outline" onClick={pairing.request} disabled={pairing.busy || !pairing.phone.trim()}>
                  {pairing.busy && <Loader2 className="size-4 animate-spin" />}
                  {t('pairingRequest')}
                </Button>
              </div>
              {pairing.code && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">{t('pairingCodeLabel')}</p>
                  <p className="font-mono text-2xl tracking-[0.3em] text-foreground" data-testid="openwa-pairing-code">
                    {pairing.code.slice(0, 4)}-{pairing.code.slice(4)}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('pairingHowTo')}</p>
                </div>
              )}
              <p className="text-xs text-amber-700 dark:text-amber-300">{t('pairingWarning')}</p>
            </div>
          )}
        </div>
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={onLogout} disabled={busy !== null}>
            {busy === 'logout' ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
            {t('cancelConnect')}
          </Button>
        )}
      </div>
    );
  }

  if (status === 'initializing' || status === 'authenticating') {
    return (
      <div className="space-y-2">
        <StatusLine
          tone="wait"
          icon={<Loader2 className="size-4 animate-spin" />}
          text={status === 'initializing' ? t('statusInitializing') : t('statusAuthenticating')}
        />
        {state.reconnect_attempts ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t('reconnectLoop', { attempts: state.reconnect_attempts })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('waitDesc')}</p>
        )}
      </div>
    );
  }

  // created / disconnected / failed / action_required
  const tone = status === 'failed' || status === 'action_required' ? 'bad' : 'muted';
  const text =
    status === 'failed'
      ? t('statusFailed')
      : status === 'action_required'
        ? t('statusActionRequired')
        : t('statusDisconnected');
  return (
    <div className="space-y-3">
      <StatusLine tone={tone} icon={<XCircle className="size-4" />} text={text} />
      {state.last_error && (
        <p className="rounded-lg bg-hover-surface/60 px-3 py-2 text-xs text-muted-foreground">
          {t('lastError')}: {state.last_error}
        </p>
      )}
      {state.reconnect_attempts ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {t('reconnectLoop', { attempts: state.reconnect_attempts })}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {status === 'disconnected' && state.phone
          ? t('restoringDesc', { phone: formatPhone(state.phone) })
          : t('disconnectedDesc')}
      </p>
      {canEdit && (
        <Button onClick={onConnect} disabled={busy !== null}>
          {busy === 'connect' && <Loader2 className="size-4 animate-spin" />}
          {t('connect')}
        </Button>
      )}
    </div>
  );
}

function GatewayDown({
  state,
  checking,
  onRetry,
}: {
  state: OpenWaGatewayState;
  checking: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('Settings.whatsapp.openwa');
  const desc =
    state === 'unconfigured'
      ? t('gatewayDownUnconfigured')
      : state === 'auth_failed'
        ? t('gatewayDownAuth')
        : t('gatewayDownUnreachable');
  return (
    <div role="alert" className="space-y-3" data-testid="openwa-gateway-down">
      <StatusLine tone="bad" icon={<CloudOff className="size-4" />} text={t('gatewayDownTitle')} />
      <p className="text-sm text-muted-foreground">{desc}</p>
      {state !== 'unconfigured' && (
        <Button variant="outline" onClick={onRetry} disabled={checking}>
          {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {t('gatewayRetry')}
        </Button>
      )}
    </div>
  );
}

function StatusLine({
  tone,
  icon,
  text,
}: {
  tone: 'ok' | 'wait' | 'bad' | 'muted';
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <p
      data-testid="openwa-status"
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium',
        tone === 'ok' && 'bg-chip-active text-chip-active-foreground',
        tone === 'wait' && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
        tone === 'bad' && 'bg-destructive/10 text-destructive',
        tone === 'muted' && 'bg-hover-surface text-muted-foreground',
      )}
    >
      {icon}
      {text}
    </p>
  );
}
