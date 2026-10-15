"use client";

import { useSyncExternalStore } from "react";
import { Toaster } from "sonner";

import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_MODE } from "@/lib/themes";

// Returns false during SSR and the first hydration render, true after —
// the sanctioned (warning-free, no setState-in-effect) way to diverge
// server vs client. Lets us match the server-rendered default on first
// paint, then adopt the real mode.
const noopSubscribe = () => () => {};
function useIsClient() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Toaster wrapper that tracks the active light/dark mode.
 *
 * Lives inside <ThemeProvider> (see layout.tsx) so it can read the
 * current mode and hand it to sonner. Colors are driven off the same
 * CSS tokens as the rest of the app, so a toast looks at home in
 * either mode without a second palette to maintain.
 *
 * The theme is gated behind `useIsClient`: the server renders
 * DEFAULT_MODE, so first client paint must too, otherwise a light-mode
 * user hydrates with a different sonner `theme` attribute than the
 * server emitted and React logs a hydration mismatch.
 */
export function ThemedToaster() {
  const { mode } = useTheme();
  const isClient = useIsClient();
  return (
    <Toaster
      theme={isClient ? mode : DEFAULT_MODE}
      position="top-right"
      // WA snackbar look: raised surface, 12px radius, soft shadow
      // instead of a border, system font at 14px.
      toastOptions={{
        style: {
          background: "var(--popover)",
          border: "none",
          borderRadius: "12px",
          boxShadow:
            "0 2px 5px 0 rgb(11 20 26 / 0.26), 0 2px 10px 0 rgb(11 20 26 / 0.16)",
          color: "var(--popover-foreground)",
          fontSize: "14px",
        },
      }}
    />
  );
}
