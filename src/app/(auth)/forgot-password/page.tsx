"use client";

import { useState } from "react";
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
  AuthNotice,
} from "@/components/auth/auth-shell";
import { MessageSquare, CheckCircle, ArrowLeft } from "lucide-react";

export default function ForgotPasswordPage() {
  const t = useTranslations("ForgotPasswordPage");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // The emailed link returns to /auth/callback, which exchanges it
    // for a recovery session and forwards to /reset-password (issue
    // #592). Supabase must allow this origin under Authentication →
    // URL Configuration → Redirect URLs, or it silently falls back to
    // its Site URL; see docs/auth-emails.md.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

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
          href="/login"
          className={buttonVariants({ variant: "secondary", size: "lg", className: "w-full" })}
        >
          {t("backToSignIn")}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      icon={MessageSquare}
      title={t("title")}
      description={t("desc")}
      footer={
        <Link
          href="/login"
          className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-hover-surface hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("backToSignIn")}
        </Link>
      }
    >
      <form onSubmit={handleReset} className="flex flex-col gap-4">
        {error && <AuthNotice tone="error">{error}</AuthNotice>}

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

        <Button type="submit" size="lg" disabled={loading} className="mt-2 w-full">
          {loading ? t("sending") : t("sendLink")}
        </Button>
      </form>
    </AuthCard>
  );
}
