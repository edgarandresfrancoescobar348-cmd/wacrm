"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import {
  AUTH_LABEL,
  AUTH_LINK,
  AuthCard,
  AuthNotice,
} from "@/components/auth/auth-shell";
import { MessageSquare, CheckCircle, UsersRound } from "lucide-react";

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // sends the verified user to /join/<token> so they land on the
  // redeem step instead of being dropped on /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("SignupPage");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("passwordsMismatch"));
      return;
    }

    if (password.length < 6) {
      setError(t("passwordTooShort"));
      return;
    }

    setLoading(true);

    // Always name our own origin as the place the confirmation link
    // returns to. Previously this was left unset unless an invite was
    // involved, so Supabase fell back to its Site URL — which on a
    // freshly-created or self-hosted project is `http://localhost:3000`
    // (issue #595) — and even when the Site URL was right the link
    // landed on `/` with an unexchanged `?code=`, so the user had to
    // sign in again after verifying. /auth/callback exchanges the link
    // for a session and forwards to `next` (issue #592). Supabase still
    // has to allow this origin under Authentication → URL Configuration
    // → Redirect URLs; see docs/auth-emails.md.
    const next = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        emailRedirectTo,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  const loginHref = inviteToken
    ? `/login?invite=${encodeURIComponent(inviteToken)}`
    : "/login";

  if (success) {
    return (
      <AuthCard
        icon={CheckCircle}
        title={t("checkEmailTitle")}
        description={t.rich("checkEmailDesc", {
          email,
          strong: (chunks) => <span className="text-foreground">{chunks}</span>,
        })}
      >
        <Link
          href={loginHref}
          className={buttonVariants({ variant: "secondary", size: "lg", className: "w-full" })}
        >
          {t("backToSignIn")}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      icon={inviteToken ? UsersRound : MessageSquare}
      title={inviteToken ? t("titleJoin") : t("title")}
      description={inviteToken ? t("descJoin") : t("desc")}
      footer={
        <>
          {t("haveAccount")}{" "}
          <Link href={loginHref} className={AUTH_LINK}>
            {t("signIn")}
          </Link>
        </>
      }
    >
      <form onSubmit={handleSignup} className="flex flex-col gap-4">
        {error && <AuthNotice tone="error">{error}</AuthNotice>}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fullName" className={AUTH_LABEL}>
            {t("fullNameLabel")}
          </Label>
          <Input
            id="fullName"
            type="text"
            placeholder={t("fullNamePlaceholder")}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email" className={AUTH_LABEL}>
            {t("emailLabel")}
          </Label>
          <Input
            id="email"
            type="email"
            placeholder={t("emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password" className={AUTH_LABEL}>
            {t("passwordLabel")}
          </Label>
          <Input
            id="password"
            type="password"
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
            placeholder={t("confirmPasswordPlaceholder")}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>

        <Button type="submit" size="lg" disabled={loading} className="mt-2 w-full">
          {loading ? t("creating") : t("submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
