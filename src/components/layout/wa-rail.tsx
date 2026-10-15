"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Bell,
  Bot,
  Crown,
  GitBranch,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  Radio,
  Settings,
  Shield,
  User,
  UserCog,
  Users,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import type { AccountRole } from "@/lib/auth/roles";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WaAvatar } from "@/components/layout/wa-panel";
import { ModeToggle } from "@/components/layout/mode-toggle";

/**
 * WhatsApp-style icon rail (64px) — the app's primary navigation.
 * Replaces the old 240px sidebar + top header: every section is an icon
 * with its label as a tooltip; the user avatar at the bottom opens the
 * account menu (profile, settings, sign out). On phones the rail turns
 * into a bottom bar.
 */

interface RailItem {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  beta?: boolean;
}

const RAIL_ITEMS: RailItem[] = [
  { href: "/inbox", labelKey: "inbox", icon: MessageCircle },
  { href: "/contacts", labelKey: "contacts", icon: Users },
  { href: "/pipelines", labelKey: "pipelines", icon: GitBranch },
  { href: "/broadcasts", labelKey: "broadcasts", icon: Radio },
  { href: "/automations", labelKey: "automations", icon: Zap },
  { href: "/flows", labelKey: "flows", icon: Workflow, beta: true },
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/agents", labelKey: "aiAgents", icon: Bot },
  { href: "/notifications", labelKey: "notifications", icon: Bell },
];

const ROLE_META: Record<AccountRole, { icon: LucideIcon; labelKey: string }> = {
  owner: { icon: Crown, labelKey: "roleOwner" },
  admin: { icon: Shield, labelKey: "roleAdmin" },
  agent: { icon: UserCog, labelKey: "roleAgent" },
  viewer: { icon: User, labelKey: "roleViewer" },
};

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function RailBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={label}
      className="pointer-events-none absolute -top-1 -right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-rail bg-primary px-1 text-[10px] leading-none font-bold text-primary-foreground"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function RailLink({
  item,
  label,
  active,
  badge,
}: {
  item: RailItem;
  label: string;
  active: boolean;
  badge?: React.ReactNode;
}) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={item.href}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex size-10 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-hover-surface text-foreground"
                : "text-muted-foreground hover:bg-hover-surface/70 hover:text-foreground",
            )}
          />
        }
      >
        <Icon className="size-[22px]" strokeWidth={active ? 2.25 : 1.75} />
        {badge}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function WaRail() {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, account, accountRole, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();

  const userName = profile?.full_name ?? profile?.email ?? t("defaultUser");
  const settingsActive = isActivePath(pathname, "/settings");
  const role = accountRole ? ROLE_META[accountRole] : null;

  const badgeFor = (href: string) => {
    if (href === "/inbox") {
      return (
        <RailBadge
          count={totalUnread}
          label={t("unreadConversations", { count: totalUnread })}
        />
      );
    }
    if (href === "/notifications") {
      return (
        <RailBadge
          count={unreadNotifications}
          label={t("unreadNotifications", { count: unreadNotifications })}
        />
      );
    }
    return null;
  };

  return (
    <TooltipProvider delay={300}>
      <nav
        aria-label={t("primaryNav")}
        className={cn(
          "z-30 flex shrink-0 bg-rail",
          // Phone: bottom bar that scrolls sideways.
          "order-last h-14 w-full items-center gap-1 overflow-x-auto border-t border-border px-2 [scrollbar-width:none]",
          // md+: the WA vertical rail.
          "md:order-none md:h-full md:w-16 md:flex-col md:overflow-visible md:border-t-0 md:border-r md:px-0 md:py-3",
        )}
      >
        <ul className="flex items-center gap-1 md:flex-col md:gap-2">
          {RAIL_ITEMS.map((item) => (
            <li key={item.href}>
              <RailLink
                item={item}
                label={
                  item.beta
                    ? `${t(item.labelKey)} · ${t("beta")}`
                    : t(item.labelKey)
                }
                active={isActivePath(pathname, item.href)}
                badge={badgeFor(item.href)}
              />
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-1 md:mt-auto md:flex-col md:gap-2">
          <div className="mx-1 h-6 w-px bg-border md:mx-0 md:mb-1 md:h-px md:w-8" />
          <ModeToggle />

          <RailLink
            item={{ href: "/settings", labelKey: "settings", icon: Settings }}
            label={t("settings")}
            active={settingsActive}
          />

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={userName}
              className="flex size-10 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring data-popup-open:ring-2 data-popup-open:ring-hover-surface"
            >
              <WaAvatar src={profile?.avatar_url} name={userName} size={32} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" sideOffset={10} className="min-w-64">
              <div className="flex items-center gap-3 px-3 py-2.5">
                <WaAvatar src={profile?.avatar_url} name={userName} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{userName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {profile?.email ?? ""}
                  </p>
                </div>
              </div>
              {account?.name && account.name !== profile?.full_name ? (
                <div className="flex items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
                  <span className="truncate" title={account.name}>
                    {account.name}
                  </span>
                  {role ? (
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-chip-active px-2 py-0.5 text-[10px] font-medium text-chip-active-foreground">
                      <role.icon className="size-3" />
                      {t(role.labelKey)}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link href="/settings?tab=profile" />}>
                <User className="size-4" />
                {t("menuProfile")}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/settings?tab=whatsapp" />}>
                <Settings className="size-4" />
                {t("menuSettings")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={signOut}>
                <LogOut className="size-4" />
                {t("menuSignOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>
    </TooltipProvider>
  );
}
