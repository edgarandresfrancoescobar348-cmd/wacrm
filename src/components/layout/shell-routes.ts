/**
 * Route prefixes whose page renders its own WhatsApp layout frame
 * (`WaListLayout` / `WaPage` from `@/components/layout/wa-panel`) and
 * therefore gets the main area edge-to-edge from the dashboard shell.
 *
 * Every other route gets the legacy frame: a padded (`p-4 sm:p-6`)
 * scrolling body, because those pages still render their own title and
 * spacing. They already pick up the new tokens and primitives.
 *
 * Phase 2: when a page adopts `WaListLayout` / `WaPage`, add its prefix
 * here in the same change.
 */
export const FULL_BLEED_ROUTE_PREFIXES: readonly string[] = [
  "/inbox",
  "/contacts",
  "/pipelines",
  "/broadcasts",
  "/automations",
  "/flows",
  "/dashboard",
  "/agents",
  "/notifications",
  "/settings",
];

function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isFullBleedRoute(pathname: string): boolean {
  return FULL_BLEED_ROUTE_PREFIXES.some((p) => matches(pathname, p));
}
