'use client';

import { useMemo, useState } from 'react';
import { BadgeCheck, Loader2, Plus, QrCode, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScopeBadge } from '@/components/inbox/scope-badge';
import { useNumberLabels } from '@/components/inbox/scope-bar';
import { useWhatsAppConnections, type ConnectionView } from '@/hooks/use-whatsapp-connections';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import { OpenWaPanel } from './openwa-panel';
import { NumberScopeControl } from './number-scope-control';

/** The official number being set up before it exists (its credentials create it). */
const NEW_OFFICIAL = 'new-official';

type AddChoice = 'official' | 'personal' | 'business';

/**
 * Settings → WhatsApp (phase 6): the account's numbers — at most one
 * official (Meta Cloud API) and any number paired by QR code, each
 * Pessoal (only its owner sees its chats) or Empresa (the team does).
 * The list shows each number's seal, name, owner and status; "Adicionar
 * número" adds one; the selected number's detail is the official API
 * form or the QR panel, as before.
 */
export function WhatsAppSettings() {
  const t = useTranslations('Settings.whatsapp.numbers');
  const tw = useTranslations('Settings.whatsapp');
  const labels = useNumberLabels();
  const { connections, canAdd, reload } = useWhatsAppConnections();
  const live = useMemo(() => (connections ?? []).filter((n) => !n.removed_at), [connections]);

  const [selected, setSelected] = useState<string | null>(null);
  const shownId = selected ?? live[0]?.id ?? null;
  const shown = live.find((n) => n.id === shownId) ?? null;

  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState<AddChoice | null>(null);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const choices: { value: AddChoice; title: string; desc: string; scope: 'personal' | 'business'; icon: React.ReactNode }[] = [];
  if (canAdd?.official) {
    choices.push({ value: 'official', title: t('addOfficial'), desc: t('addOfficialDesc'), scope: 'business', icon: <BadgeCheck className="size-5" /> });
  }
  if (canAdd?.personal_qr) {
    choices.push({ value: 'personal', title: t('addPersonal'), desc: t('addPersonalDesc'), scope: 'personal', icon: <QrCode className="size-5" /> });
  }
  if (canAdd?.business_qr) {
    choices.push({ value: 'business', title: t('addBusiness'), desc: t('addBusinessDesc'), scope: 'business', icon: <QrCode className="size-5" /> });
  }

  function openAdd() {
    setChoice(choices[0]?.value ?? null);
    setLabel('');
    setAdding(true);
  }

  async function confirmAdd() {
    if (!choice) return;
    if (choice === 'official') {
      setAdding(false);
      setSelected(NEW_OFFICIAL);
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/whatsapp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: choice, label: label.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('addFailed'));
        return;
      }
      await reload();
      setSelected(data.connection.id as string);
      setAdding(false);
      toast.success(t('added'));
    } finally {
      setCreating(false);
    }
  }

  async function remove(n: ConnectionView) {
    if (!window.confirm(t('removeConfirm', { name: labels.name(n) }))) return;
    setRemoving(n.id);
    try {
      const res = await fetch(`/api/whatsapp/connections/${n.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('removeFailed'));
        return;
      }
      toast.success(t('removed'));
      if (shownId === n.id) setSelected(null);
      await reload();
    } finally {
      setRemoving(null);
    }
  }

  const statusOf = (n: ConnectionView) =>
    n.status === 'connected' ? t('statusConnected') : t('statusDisconnected');

  return (
    <section className="animate-in fade-in-50 duration-200" data-testid="whatsapp-numbers">
      <SettingsPanelHead
        title={tw('title')}
        description={t('description')}
        action={
          choices.length ? (
            <Button onClick={openAdd} data-testid="add-number">
              <Plus className="size-4" />
              {t('add')}
            </Button>
          ) : undefined
        }
      />

      {connections === undefined ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </div>
      ) : live.length === 0 && selected !== NEW_OFFICIAL ? (
        <div className="rounded-xl bg-surface p-6 text-center">
          <p className="text-[15px] text-foreground">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('emptyDesc')}</p>
        </div>
      ) : (
        <ul className="mb-6 divide-y divide-border overflow-hidden rounded-xl bg-surface" aria-label={t('listLabel')}>
          {live.map((n) => {
            const kind = n.provider === 'meta' ? t('kindOfficial') : t('kindQr');
            const scope = labels.scope(n.scope);
            const owner = n.scope === 'personal' && n.owner_name ? n.owner_name : null;
            return (
              <li key={n.id}>
                <div
                  className={cn(
                    'flex items-center gap-3 px-4 py-3 transition-colors',
                    shownId === n.id ? 'bg-hover-surface' : 'hover:bg-hover-surface/60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(n.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
                    aria-current={shownId === n.id ? 'true' : undefined}
                    data-testid="number-row"
                  >
                    <ScopeBadge scope={n.scope} label={labels.badge(n, true)} size={32} className="ring-0" decorative />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[15px] text-foreground">{labels.name(n)}</span>
                        {n.is_default ? (
                          <span className="shrink-0 rounded-full bg-chip-active px-2 py-0.5 text-[11px] font-medium text-chip-active-foreground">
                            {t('default')}
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[kind, owner ? t('personalOf', { name: owner }) : scope].join(' · ')}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-xs',
                        n.status === 'connected'
                          ? 'bg-chip-active text-chip-active-foreground'
                          : 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
                      )}
                    >
                      {statusOf(n)}
                    </span>
                  </button>
                  {n.can_disconnect ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('remove')}
                      title={t('remove')}
                      disabled={removing === n.id}
                      onClick={() => void remove(n)}
                    >
                      {removing === n.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
          {selected === NEW_OFFICIAL ? (
            <li className="flex items-center gap-3 bg-hover-surface px-4 py-3">
              <ScopeBadge scope="business" label={labels.scope('business')} size={32} className="ring-0" decorative />
              <span className="text-[15px] text-foreground">{t('addOfficial')}</span>
            </li>
          ) : null}
        </ul>
      )}

      {selected === NEW_OFFICIAL ? (
        <WhatsAppConfig embedded onSaved={() => void reload().then(() => setSelected(null))} />
      ) : null}
      {selected !== NEW_OFFICIAL && shown ? (
        <NumberScopeControl key={`scope-${shown.id}`} connection={shown} onChanged={reload} />
      ) : null}
      {selected === NEW_OFFICIAL ? null : shown ? (
        shown.provider === 'meta' ? (
          <WhatsAppConfig key={shown.id} embedded connection={shown} onSaved={() => void reload()} />
        ) : shown.visible || shown.can_operate ? (
          <OpenWaPanel key={shown.id} connection={shown} onChanged={reload} />
        ) : (
          <p className="rounded-xl bg-surface p-4 text-sm text-muted-foreground">
            {shown.can_disconnect ? t('othersPersonalRemovable') : t('othersPersonal')}
          </p>
        )
      ) : null}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('addTitle')}</DialogTitle>
            <DialogDescription>{t('addDesc')}</DialogDescription>
          </DialogHeader>
          <div role="radiogroup" aria-label={t('addTitle')} className="space-y-2">
            {choices.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={choice === c.value}
                onClick={() => setChoice(c.value)}
                data-choice={c.value}
                className={cn(
                  'flex w-full items-start gap-3 rounded-xl bg-hover-surface/60 p-3 text-left outline-none transition-colors hover:bg-hover-surface focus-visible:ring-2 focus-visible:ring-ring',
                  choice === c.value && 'ring-2 ring-primary',
                )}
              >
                <ScopeBadge scope={c.scope} label={labels.scope(c.scope)} size={28} className="mt-0.5 ring-0" decorative />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] text-foreground">{c.title}</span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">{c.desc}</span>
                </span>
              </button>
            ))}
          </div>
          {choice && choice !== 'official' ? (
            <div className="space-y-2">
              <Label htmlFor="number-label" className="text-muted-foreground">{t('labelLabel')}</Label>
              <Input
                id="number-label"
                value={label}
                maxLength={60}
                placeholder={choice === 'personal' ? t('labelPlaceholderPersonal') : t('labelPlaceholderBusiness')}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void confirmAdd()} disabled={!choice || creating} data-testid="add-number-confirm">
              {creating && <Loader2 className="size-4 animate-spin" />}
              {choice === 'official' ? t('continue') : t('addConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
