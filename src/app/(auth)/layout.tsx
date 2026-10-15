import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthScreen } from "@/components/auth/auth-shell";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

// Every auth page renders inside the same WhatsApp-Web-style frame
// (wallpaper, brand bar, secure-connection footnote); pages only render
// their card.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthScreen>{children}</AuthScreen>;
}
