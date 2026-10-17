'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { ScopeBadge } from '@/components/inbox/scope-badge';
import type { ConnectionView } from '@/hooks/use-whatsapp-connections';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';

type Scope = 'personal' | 'business';

interface Preview {
  conversations: number;
  saved_names: number;
  members: { user_id: string; name: string }[];
}

/**
 * Pessoal or Empresa, on the number's own header in Settings → WhatsApp
 * (phase 6b). Two options with their seal; the one the viewer may not
 * pick is disabled with the reason under it. Picking the other side asks
 * first — the confirmation says what changes, with the counts — and an
 * admin making a business number personal chooses its owner (themself by
 * default). The server decides again (set_connection_scope, 089).
 */
export function NumberScopeControl({
  connection,
  onChanged,
}: {
  connection: ConnectionView;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('Settings.whatsapp.numbers.scopeChange');
  const { user } = useAuth();
  const [target, setTarget] = useState<Scope | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [owner, setOwner] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const official = connection.provider === 'meta';
  const mayPick = (s: Scope) =>
    s === connection.scope ? false : s === 'personal' ? Boolean(connection.can_make_personal) : Boolean(connection.can_make_business);
  const hint = official
    ? t('officialAlwaysBusiness')
    : connection.scope === 'personal' && !connection.can_make_business
      ? t('onlyOwnerMakesBusiness', { name: connection.owner_name ?? t('itsOwner') })
      : connection.scope === 'business' && !connection.can_make_personal
        ? t('onlyAdminMakesPersonal')
        : null;

  async function ask(s: Scope) {
    if (!mayPick(s)) return;
    setTarget(s);
    setPreview(null);
    setOwner(user?.id ?? '');
    const res = await fetch(`/api/whatsapp/connections/${connection.id}/scope`, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) {
      toast.error(t('failed'));
      setTarget(null);
      return;
    }
    setPreview((await res.json()) as Preview);
  }

  async function confirm() {
    if (!target) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/whatsapp/connections/${connection.id}/scope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: target, owner_user_id: target === 'personal' ? owner || null : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('failed'));
        return;
      }
      toast.success(target === 'personal' ? t('donePersonal') : t('doneBusiness'));
      setTarget(null);
      await onChanged();
    } finally {
      setSaving(false);
    }
  }

  const options: { value: Scope; title: string }[] = [
    { value: 'personal', title: t('personal') },
    { value: 'business', title: t('business') },
  ];
  const forOther = target === 'personal' && owner && owner !== user?.id;

  return (
    <div className="mb-4 rounded-xl bg-surface p-4" data-testid="number-scope">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id={`scope-${connection.id}`} className="text-sm font-medium text-foreground">
          {t('title')}
        </p>
        <div role="radiogroup" aria-labelledby={`scope-${connection.id}`} className="flex flex-wrap gap-2">
          {options.map((o) => {
            const current = connection.scope === o.value;
            const enabled = mayPick(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={current}
                disabled={!current && !enabled}
                onClick={() => void ask(o.value)}
                data-scope-option={o.value}
                className={cn(
                  'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  current
                    ? 'bg-chip-active text-chip-active-foreground'
                    : enabled
                      ? 'bg-hover-surface/60 text-foreground hover:bg-hover-surface'
                      : 'cursor-not-allowed bg-hover-surface/40 text-muted-foreground opacity-60',
                )}
              >
                <ScopeBadge scope={o.value} label={o.title} size={18} className="ring-0" decorative />
                {o.title}
              </button>
            );
          })}
        </div>
      </div>
      {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}

      <Dialog open={target !== null} onOpenChange={(open) => !open && !saving && setTarget(null)}>
        <DialogContent className="sm:max-w-md" data-testid="scope-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {target ? <ScopeBadge scope={target} label="" size={22} className="ring-0" decorative /> : null}
              {target === 'personal' ? t('confirmPersonalTitle') : t('confirmBusinessTitle')}
            </DialogTitle>
            <DialogDescription>
              {preview === null ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> {t('counting')}
                </span>
              ) : target === 'personal' ? (
                t('confirmPersonal', { count: preview.conversations })
              ) : (
                t('confirmBusiness', { count: preview.conversations })
              )}
            </DialogDescription>
          </DialogHeader>
          {preview && target === 'business' && preview.saved_names > 0 ? (
            <p className="text-sm text-muted-foreground">{t('savedNames', { count: preview.saved_names })}</p>
          ) : null}
          {preview && target === 'personal' && preview.members.length > 1 ? (
            <div className="space-y-2">
              <Label htmlFor="scope-owner" className="text-muted-foreground">
                {t('ownerLabel')}
              </Label>
              <select
                id="scope-owner"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                {preview.members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.user_id === user?.id ? t('me', { name: m.name }) : m.name}
                  </option>
                ))}
              </select>
              {forOther ? <p className="text-xs text-muted-foreground">{t('ownerOtherHint')}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void confirm()} disabled={!preview || saving} data-testid="scope-confirm-button">
              {saving && <Loader2 className="size-4 animate-spin" />}
              {target === 'personal' ? t('confirmPersonalButton') : t('confirmBusinessButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
