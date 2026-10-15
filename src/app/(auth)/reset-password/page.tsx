"use client";

// ============================================================
// /reset-password — the form the password-reset email leads to.
//
// The emailed link lands on /auth/callback, which exchanges it for a
// session and 303s here. So on arrival the visitor either has a
// recovery session (show the form) or doesn't (the link was spent,
// expired, or opened in a browser without the PKCE verifier cookie —
// say so, with a way to request a new one). Bouncing to /login with
// no explanation was the locked-out experience issue #592 describes.
//
// Not gated by the middleware on purpose: the "expired" state must be
// reachable signed-out, and a signed-in visitor must not be redirected
// away from the very page they need.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import {
  AUTH_LABEL,
  AuthCard,
  AuthLoading,
  AuthNotice,
} from "@/components/auth/auth-shell";
import { CheckCircle, KeyRound, MailX } from "lucide-react";

type Status = "checking" | "ready" | "expired" | "done";

export default function ResetPasswordPage() {
  const t = useTranslations("ResetPasswordPage");
  const supabase = createClient();

  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The callback wrote the session cookies server-side; the browser
    // client reads them here. No user → the link didn't yield a session.
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!cancelled) setStatus(user ? "ready" : "expired");
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("passwordsMismatch"));
      return;
    }
    // Same floor as /signup.
    if (password.length < 6) {
      setError(t("passwordTooShort"));
      return;
    }

    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);

    if (error) {
      setError(error.message);
      return;
    }
    setStatus("done");
  };

  if (status === "checking") {
    return (
      <AuthCard>
        <AuthLoading label={t("checking")} />
      </AuthCard>
    );
  }

  if (status === "expired") {
    return (
      <AuthCard
        icon={MailX}
        tone="danger"
        title={t("expiredTitle")}
        description={t("expiredDesc")}
      >
        <div className="flex flex-col gap-3">
          <Link
            href="/forgot-password"
            className={buttonVariants({ size: "lg", className: "w-full" })}
          >
            {t("requestNewLink")}
          </Link>
          <Link
            href="/login"
            className={buttonVariants({ variant: "secondary", size: "lg", className: "w-full" })}
          >
            {t("backToSignIn")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (status === "done") {
    return (
      <AuthCard
        icon={CheckCircle}
        title={t("successTitle")}
        description={t("successDesc")}
      >
        <Button
          size="lg"
          className="w-full"
          onClick={() => {
            window.location.href = "/dashboard";
          }}
        >
          {t("continueToDashboard")}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard icon={KeyRound} title={t("title")} description={t("desc")}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <AuthNotice tone="error">{error}</AuthNotice>}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password" className={AUTH_LABEL}>
            {t("passwordLabel")}
          </Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder={t("passwordPlaceholder")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirmPassword" className={AUTH_LABEL}>
            {t("confirmPasswordLabel")}
          </Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder={t("confirmPasswordPlaceholder")}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>

        <Button type="submit" size="lg" disabled={saving} className="mt-2 w-full">
          {saving ? t("saving") : t("submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
