'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Four UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + signup  │
//   │ ok:true              │ signed out    │ "Sign up" + "Sign in"    │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
// Auto-redeem would also race with the signup flow returning to
// this page after email verification.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { formatDateMedium } from '@/lib/locale-format';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { AuthCard, AuthLoading } from '@/components/auth/auth-shell';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';

interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  expires_at: string;
}
interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error';
}
type PeekResult = PeekOk | PeekFail;

// Message keys per peek failure reason — resolved through `t` inside
// the component (hooks can't run at module level). Snake_case reasons
// come from the API; the catalogue uses camelCase leaves.
const FAIL_KEY: Record<PeekFail['reason'], 'notFound' | 'used' | 'expired' | 'serverError'> = {
  not_found: 'notFound',
  used: 'used',
  expired: 'expired',
  server_error: 'serverError',
};

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const t = useTranslations('JoinPage');
  const locale = useLocale();
  // Role labels are shared with Settings → Members so the invite page
  // and the member list always agree on what a role is called.
  const tRoles = useTranslations('Settings.roles');

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page. We hit Supabase
  // directly the same way `/login` and `/signup` do.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined, // undefined = unknown / still loading; null = signed out
  );
  const [accepting, setAccepting] = useState(false);
  // `redeem_invitation` returns 409 when the caller's current account
  // has domain data, or they're already a member of a shared account.
  // A transient toast wasn't enough — the user has no actionable next
  // step. Surface a blocking modal that walks them through it.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Extracted so the "Try again" button on the server_error card
  // can re-run the same logic without remounting the component.
  const loadPeekAndAuth = useCallback(async () => {
    if (!token) return;
    setPeek(null);
    setAuthedUserId(undefined);
    try {
      const [peekRes, authRes] = await Promise.all([
        fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
          cache: 'no-store',
        }),
        createClient().auth.getUser(),
      ]);
      const peekBody = (await peekRes.json()) as PeekResult;
      setPeek(peekBody);
      setAuthedUserId(authRes.data.user?.id ?? null);
    } catch (err) {
      console.error('[join] peek error:', err);
      setPeek({ ok: false, reason: 'server_error' });
      setAuthedUserId(null);
    }
  }, [token]);

  // Fetch peek + auth state on mount. The peek endpoint is
  // rate-limited per-IP (30/min) so double-mounting in React 19
  // strict mode dev is harmless. We also use the `cancelled` flag
  // to drop setState calls if the component unmounts mid-fetch.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [peekRes, authRes] = await Promise.all([
          fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
            cache: 'no-store',
          }),
          createClient().auth.getUser(),
        ]);
        const peekBody = (await peekRes.json()) as PeekResult;
        if (cancelled) return;
        setPeek(peekBody);
        setAuthedUserId(authRes.data.user?.id ?? null);
      } catch (err) {
        console.error('[join] peek error:', err);
        if (cancelled) return;
        setPeek({ ok: false, reason: 'server_error' });
        setAuthedUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        // 409 = caller already has data / is in another shared
        // account. The redeem RPC's error message is descriptive
        // enough to show directly; we open a modal so the user has
        // a clear next-action (sign out → use different email)
        // rather than a 3-second toast.
        if (res.status === 409) {
          setConflictMessage(payload.error || t('conflictDefault'));
        } else {
          toast.error(payload.error || t('acceptFailed'));
        }
        setAccepting(false);
        return;
      }
      toast.success(t('welcome'));
      // Full reload (not router.push) so AuthProvider re-fetches
      // the profile with the new account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error(t('serverUnreachable'));
      setAccepting(false);
    }
  }, [token, t]);

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Hard reload so the new auth state propagates everywhere
      // (middleware, AuthProvider). Preserves the invite token in
      // the URL so the rebuilt page renders the signed-out CTA path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error(t('signOutFailed'));
      setSigningOut(false);
    }
  }, [t]);

  // ----- Loading state (peek pending OR auth not yet resolved) -----
  if (peek === null || authedUserId === undefined) {
    return (
      <AuthCard>
        <AuthLoading label={t('verifying')} />
      </AuthCard>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    const failKey = FAIL_KEY[peek.reason];
    return (
      <AuthCard
        icon={MailX}
        tone="danger"
        title={t(`fail.${failKey}Title`)}
        description={t(`fail.${failKey}Body`)}
      >
        <div className="flex flex-col gap-3">
          {/* For server_error the failure is transient — the network
              flapped or the peek endpoint hiccupped. Try-again is
              the right primary action; the "create account" /
              "sign in" links stay as secondary options. Other
              failure reasons (not_found / used / expired) are
              terminal for this token, so no retry — just the
              signup/sign-in escape hatches. */}
          {peek.reason === 'server_error' ? (
            <>
              <Button size="lg" onClick={loadPeekAndAuth} className="w-full">
                {t('tryAgain')}
              </Button>
              <Link href="/signup" className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'w-full' })}>
                {t('createNewAccount')}
              </Link>
            </>
          ) : (
            <>
              <Link href="/signup" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
                {t('createNewAccount')}
              </Link>
              <Link href="/login" className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'w-full' })}>
                {t('signIn')}
              </Link>
            </>
          )}
        </div>
      </AuthCard>
    );
  }

  // ----- Peek OK -----
  const inviteTitle = t.rich('invitedTo', {
    name: peek.account_name,
    account: (chunks) => <span className="text-primary-text">{chunks}</span>,
  });
  const inviteDescription = t.rich('joinAs', {
    role: tRoles(peek.role),
    date: formatDateMedium(peek.expires_at, locale),
    badge: (chunks) => (
      <span className="inline-flex items-center gap-1 text-foreground">
        <ShieldCheck className="size-3.5 text-primary-text" />
        {chunks}
      </span>
    ),
  });

  // ----- Authed: show Accept button -----
  if (authedUserId) {
    return (
      <>
        <AuthCard
          icon={UsersRound}
          title={inviteTitle}
          description={inviteDescription}
          footer={<span className="text-xs">{t('acceptNote', { name: peek.account_name })}</span>}
        >
          <Button size="lg" onClick={handleAccept} disabled={accepting} className="w-full">
            {accepting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('accepting')}
              </>
            ) : (
              <>
                <CheckCircle className="size-4" />
                {t('acceptInvitation')}
              </>
            )}
          </Button>
        </AuthCard>

        {/* Conflict modal — opens when the redeem endpoint returns 409
            (caller already in a shared account or has domain data).
            Blocks the flow until the user picks a recovery action so
            they aren't stuck retrying an inevitable failure. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <span className="mb-1 flex size-14 items-center justify-center rounded-full bg-amber-500/12 text-amber-500">
                <AlertTriangle className="size-6" strokeWidth={1.75} />
              </span>
              <DialogTitle>
                {t('conflictTitle', { name: peek.account_name })}
              </DialogTitle>
              <DialogDescription>{conflictMessage}</DialogDescription>
            </DialogHeader>
            <div className="rounded-xl bg-hover-surface px-4 py-3 text-[13px] text-muted-foreground">
              <p>
                {t.rich('conflictBody', {
                  name: peek.account_name,
                  account: (chunks) => (
                    <span className="text-foreground">{chunks}</span>
                  ),
                })}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConflictMessage(null)}>
                {t('staySignedIn')}
              </Button>
              <Button onClick={handleSignOutAndRetry} disabled={signingOut}>
                {signingOut ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('signingOut')}
                  </>
                ) : (
                  t('signOutSwitch')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Not authed: prompt to sign up or sign in -----
  return (
    <AuthCard icon={UsersRound} title={inviteTitle} description={inviteDescription}>
      <div className="flex flex-col gap-3">
        <Link
          href={`/signup?invite=${encodeURIComponent(token!)}`}
          className={buttonVariants({ size: 'lg', className: 'w-full' })}
        >
          {t('createAndJoin')}
        </Link>
        <Link
          href={`/login?invite=${encodeURIComponent(token!)}`}
          className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'w-full' })}
        >
          {t('haveAccount')}
        </Link>
      </div>
    </AuthCard>
  );
}
