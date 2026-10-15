"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { WaRail } from "@/components/layout/wa-rail";
import { WaLoadingScreen } from "@/components/layout/wa-loading-screen";
import { isFullBleedRoute } from "@/components/layout/shell-routes";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { BrowserNotificationsListener } from "@/components/notifications/browser-notifications-listener";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) return <WaLoadingScreen />;

  if (!user) return null;

  // Redesigned pages (WaListLayout / WaPage) own their frame and get the
  // main area edge-to-edge; pages not redesigned yet keep the old padded
  // scroll body (they render their own title). See shell-routes.ts.
  const fullBleed = isFullBleedRoute(pathname);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background md:flex-row">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* Desktop alerts for new customer messages (opt-in via Settings →
          Your profile). Headless — renders nothing. */}
      <BrowserNotificationsListener />
      <WaRail />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {fullBleed ? (
          <>
            {/* Above every page: writes are being rejected and here's why.
                Renders nothing unless the account/role failed to resolve. */}
            <div className="shrink-0 empty:hidden [&>*]:m-2">
              <AccountAccessAlert />
            </div>
            <div className="min-h-0 flex-1">{children}</div>
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <AccountAccessAlert />
              {children}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
