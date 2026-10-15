"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Zap,
  Plus,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
  FileText,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
  Power,
  History,
  Activity,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useCan } from "@/hooks/use-can"
import { useTranslations } from "next-intl"
import type { Automation } from "@/types"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  WaChip,
  WaChipRow,
  WaEmptyState,
  WaIconButton,
  WaListLayout,
  WaListPanel,
  WaListRow,
  WaPanelHeader,
  WaSearchPill,
} from "@/components/layout/wa-panel"
import { WaFrame, WaFrameCenter } from "@/components/automations/wa-frame"
import {
  WaBackButton,
  WaGatedPrimaryAction,
  WaIconAvatar,
  WaInfoHero,
  WaInfoRow,
  WaInfoSection,
  WaListNotice,
  WaStatusPill,
} from "@/components/automations/wa-kit"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import { formatRelative, isKnownTrigger } from "@/lib/automations/trigger-meta"

const TEMPLATE_ORDER: TemplateSlug[] = [
  "welcome_message",
  "out_of_office",
  "lead_qualifier",
  "follow_up_reminder",
]

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
}

type StatusFilter = "all" | "active" | "paused"

export default function AutomationsPage() {
  const router = useRouter()
  const canCreate = useCan("send-messages")
  const t = useTranslations("Automations.list")
  const tGate = useTranslations("GatedButton")
  const tTriggers = useTranslations("Automations.builder.triggers")
  const tRelative = useTranslations("Automations.relative")
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<StatusFilter>("all")

  async function load() {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from("automations")
        .select("*")
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setAutomations((data ?? []) as Automation[])
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"))
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function toggleActive(a: Automation, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations((prev) =>
      prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ?? prev,
    )
    const res = await fetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // Roll back on error.
      setAutomations((prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ?? prev,
      )
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.updateError"))
      return
    }
    toast.success(next ? t("toasts.activated") : t("toasts.paused"))
  }

  async function duplicate(a: Automation) {
    const res = await fetch(`/api/automations/${a.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.duplicateError"))
      return
    }
    toast.success(t("toasts.duplicated"))
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await fetch(`/api/automations/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.deleteError"))
      return
    }
    toast.success(t("toasts.deleted"))
    if (selectedId === pendingDelete.id) setSelectedId(null)
    setPendingDelete(null)
    load()
  }

  async function startFromTemplate(slug: TemplateSlug) {
    router.push(`/automations/new?template=${slug}`)
  }

  const triggerLabel = (a: Automation) =>
    isKnownTrigger(a.trigger_type)
      ? tTriggers(`${a.trigger_type}.label`)
      : a.trigger_type

  const runsLabel = (a: Automation) =>
    a.execution_count === 1
      ? t("runs", { count: a.execution_count })
      : t("runsPlural", { count: a.execution_count })

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (automations ?? []).filter((a) => {
      if (filter === "active" && !a.is_active) return false
      if (filter === "paused" && a.is_active) return false
      if (!q) return true
      return (
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q)
      )
    })
  }, [automations, search, filter])

  if (error) {
    return (
      <WaFrameCenter>
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("retry")}
        </Button>
      </WaFrameCenter>
    )
  }

  if (automations === null) {
    return (
      <WaFrameCenter>
        <Loader2 className="size-6 animate-spin text-primary-text" />
      </WaFrameCenter>
    )
  }

  const selected = automations.find((a) => a.id === selectedId) ?? null
  const activeCount = automations.filter((a) => a.is_active).length
  const pausedCount = automations.length - activeCount

  const templateActions = TEMPLATE_ORDER.map((slug) => ({
    icon: TEMPLATE_ICON[slug],
    label: AUTOMATION_TEMPLATES[slug].name,
    onClick: () => startFromTemplate(slug),
  }))

  const list = (
    <WaListPanel
      title={t("title")}
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t("openMenu")}
                  className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-hover-surface hover:text-foreground data-[popup-open]:bg-hover-surface"
                />
              }
            >
              <MoreVertical className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-[13px] font-normal text-muted-foreground">
                  {t("templatesTitle")}
                </DropdownMenuLabel>
                {TEMPLATE_ORDER.map((slug) => {
                  const Icon = TEMPLATE_ICON[slug]
                  return (
                    <DropdownMenuItem
                      key={slug}
                      disabled={!canCreate}
                      onClick={() => startFromTemplate(slug)}
                    >
                      <Icon className="size-4" />
                      {AUTOMATION_TEMPLATES[slug].name}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <WaGatedPrimaryAction
            icon={Plus}
            label={t("create")}
            canAct={canCreate}
            gateTitle={tGate("readOnly", { action: tGate("reasons.createAutomations") })}
            onClick={() => router.push("/automations/new")}
          />
        </>
      }
      search={
        <WaSearchPill
          value={search}
          onChange={setSearch}
          placeholder={t("searchPlaceholder")}
          clearLabel={t("clearSearch")}
          aria-label={t("searchPlaceholder")}
        />
      }
      filters={
        <WaChipRow>
          <WaChip active={filter === "all"} onClick={() => setFilter("all")}>
            {t("filterAll")}
          </WaChip>
          <WaChip
            active={filter === "active"}
            count={activeCount}
            onClick={() => setFilter("active")}
          >
            {t("filterActive")}
          </WaChip>
          <WaChip
            active={filter === "paused"}
            count={pausedCount}
            onClick={() => setFilter("paused")}
          >
            {t("filterPaused")}
          </WaChip>
        </WaChipRow>
      }
    >
      {automations.length === 0 ? (
        <WaListNotice>{t("emptyTitle")}</WaListNotice>
      ) : visible.length === 0 ? (
        <WaListNotice>{t("noMatches")}</WaListNotice>
      ) : (
        visible.map((a) => (
          <WaListRow
            key={a.id}
            active={a.id === selectedId}
            onClick={() => setSelectedId(a.id)}
            avatar={
              <WaIconAvatar icon={Zap} tone={a.is_active ? "accent" : "muted"} />
            }
            title={a.name}
            meta={formatRelative(a.last_executed_at, tRelative)}
            metaHighlight={a.is_active && !!a.last_executed_at}
            subtitle={
              <span className="truncate">
                {triggerLabel(a)} · {runsLabel(a)}
              </span>
            }
            trailing={
              a.is_active ? (
                <span
                  className="size-2.5 rounded-full bg-primary"
                  aria-label={t("activeIndicator")}
                />
              ) : null
            }
          />
        ))
      )}
    </WaListPanel>
  )

  return (
    <WaFrame>
      <WaListLayout list={list} showMain={!!selected}>
        {selected ? (
          <AutomationDetail
            automation={selected}
            triggerLabel={triggerLabel(selected)}
            runsLabel={runsLabel(selected)}
            lastRun={formatRelative(selected.last_executed_at, tRelative)}
            onBack={() => setSelectedId(null)}
            onToggle={(next) => toggleActive(selected, next)}
            onEdit={() => router.push(`/automations/${selected.id}/edit`)}
            onDuplicate={() => duplicate(selected)}
            onLogs={() => router.push(`/automations/${selected.id}/logs`)}
            onDelete={() => setPendingDelete(selected)}
          />
        ) : (
          <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-wallpaper">
            <WaEmptyState
              icon={Zap}
              title={automations.length === 0 ? t("emptyTitle") : t("title")}
              description={
                automations.length === 0 ? t("emptyPaneDesc") : t("paneHint")
              }
              cta={
                canCreate
                  ? { label: t("create"), onClick: () => router.push("/automations/new") }
                  : undefined
              }
              actions={canCreate ? templateActions : undefined}
            />
          </div>
        )}
      </WaListLayout>

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteDesc", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WaFrame>
  )
}

function AutomationDetail({
  automation,
  triggerLabel,
  runsLabel,
  lastRun,
  onBack,
  onToggle,
  onEdit,
  onDuplicate,
  onLogs,
  onDelete,
}: {
  automation: Automation
  triggerLabel: string
  runsLabel: string
  lastRun: string
  onBack: () => void
  onToggle: (next: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onLogs: () => void
  onDelete: () => void
}) {
  const t = useTranslations("Automations.list")
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <WaPanelHeader
        leading={
          <>
            <WaBackButton label={t("closeDetail")} onClick={onBack} className="lg:hidden" />
            <WaIconAvatar
              icon={Zap}
              size={40}
              tone={automation.is_active ? "accent" : "muted"}
            />
          </>
        }
        title={automation.name}
        subtitle={triggerLabel}
        actions={
          <>
            <WaIconButton icon={Pencil} label={t("edit")} onClick={onEdit} />
            <WaIconButton icon={History} label={t("viewLogs")} onClick={onLogs} />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={t("openMenu")}
                    className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-hover-surface hover:text-foreground data-[popup-open]:bg-hover-surface"
                  />
                }
              >
                <MoreVertical className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="size-4" />
                  {t("edit")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDuplicate}>
                  <Copy className="size-4" />
                  {t("duplicate")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onLogs}>
                  <FileText className="size-4" />
                  {t("viewLogs")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 className="size-4" />
                  {t("delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        className="border-b border-border"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-rail">
        <WaInfoHero
          avatar={
            <WaIconAvatar
              icon={Zap}
              size={120}
              tone={automation.is_active ? "accent" : "muted"}
            />
          }
          title={automation.name}
          subtitle={automation.description || undefined}
        >
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <WaStatusPill tone={automation.is_active ? "active" : "neutral"}>
              {automation.is_active ? t("statusActive") : t("statusPaused")}
            </WaStatusPill>
            <WaStatusPill tone="neutral">{triggerLabel}</WaStatusPill>
          </div>
          <Button onClick={onEdit} className="mt-5">
            <Pencil className="size-4" />
            {t("edit")}
          </Button>
        </WaInfoHero>

        <WaInfoSection label={t("sectionStatus")}>
          <WaInfoRow
            icon={Power}
            label={automation.is_active ? t("statusActive") : t("statusPaused")}
            value={t("statusHint")}
            trailing={
              <Switch
                checked={automation.is_active}
                onCheckedChange={(v) => onToggle(!!v)}
                aria-label={automation.is_active ? t("deactivate") : t("activate")}
              />
            }
          />
        </WaInfoSection>

        <WaInfoSection label={t("sectionActivity")}>
          <WaInfoRow icon={Zap} label={triggerLabel} value={t("sectionTrigger")} />
          <WaInfoRow icon={Activity} label={runsLabel} value={t("lastRun", { time: lastRun })} />
          <WaInfoRow icon={History} label={t("viewLogs")} onClick={onLogs} />
        </WaInfoSection>

        <WaInfoSection>
          <WaInfoRow icon={Copy} label={t("duplicate")} onClick={onDuplicate} />
          <WaInfoRow icon={Trash2} label={t("delete")} onClick={onDelete} destructive />
        </WaInfoSection>
      </div>
    </div>
  )
}
