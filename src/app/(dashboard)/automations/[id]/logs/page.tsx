"use client"

import { use, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronDown, History, Loader2, X, Zap } from "lucide-react"
import { useTranslations } from "next-intl"

import { createClient } from "@/lib/supabase/client"
import type {
  Automation,
  AutomationLog,
  AutomationLogStepResult,
} from "@/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatRelative } from "@/lib/automations/trigger-meta"
import {
  WaAvatar,
  WaCenteredState,
  WaEmptyState,
  WaPanelHeader,
} from "@/components/layout/wa-panel"
import { WaBackButton, WaIconAvatar, WaStatusPill } from "@/components/automations/wa-kit"

export default function AutomationLogsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const t = useTranslations("Automations.logs")
  const tRelative = useTranslations("Automations.relative")

  const [automation, setAutomation] = useState<Automation | null>(null)
  const [logs, setLogs] = useState<AutomationLog[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openLogId, setOpenLogId] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const [autRes, logRes] = await Promise.all([
          supabase
            .from("automations")
            .select("*")
            .eq("id", id)
            .maybeSingle(),
          supabase
            .from("automation_logs")
            .select("*, contact:contacts(id, name, phone)")
            .eq("automation_id", id)
            .order("created_at", { ascending: false })
            .limit(100),
        ])
        if (autRes.error) throw autRes.error
        if (logRes.error) throw logRes.error
        setAutomation(autRes.data as Automation | null)
        setLogs((logRes.data ?? []) as AutomationLog[])
      } catch (err) {
        setError(err instanceof Error ? err.message : t("loadError"))
      }
    }
    load()
  }, [id])

  if (error) {
    return (
      <WaCenteredState>
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => router.push("/automations")}>
          {t("back")}
        </Button>
      </WaCenteredState>
    )
  }

  if (!automation || logs === null) {
    return (
      <WaCenteredState>
        <Loader2 className="size-6 animate-spin text-primary-text" />
      </WaCenteredState>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <WaPanelHeader
        leading={
          <>
            <WaBackButton label={t("backAria")} onClick={() => router.push("/automations")} />
            <WaIconAvatar
              icon={Zap}
              size={40}
              tone={automation.is_active ? "accent" : "muted"}
            />
          </>
        }
        title={automation.name}
        subtitle={t("title")}
        className="border-b border-border"
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-wallpaper">
        <div className="mx-auto w-full max-w-3xl px-3 py-6 sm:px-6">
          {logs.length === 0 ? (
            <WaEmptyState
              icon={History}
              title={t("emptyTitle")}
              description={t("emptyDesc")}
            />
          ) : (
            <ul className="flex flex-col gap-0.5 rounded-xl bg-background p-2 shadow-sm">
              {logs.map((log) => {
                const isOpen = openLogId === log.id
                const contactName =
                  log.contact?.name ?? log.contact?.phone ?? t("unknownContact")
                const stepCount = log.steps_executed?.length ?? 0
                return (
                  <li key={log.id}>
                    <button
                      type="button"
                      onClick={() => setOpenLogId(isOpen ? null : log.id)}
                      aria-expanded={isOpen}
                      className={cn(
                        "flex min-h-[72px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isOpen ? "bg-hover-surface" : "hover:bg-hover-surface/60",
                      )}
                    >
                      <WaAvatar name={contactName} size={44} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-base leading-[21px] text-foreground">
                            {contactName}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatRelative(log.created_at, tRelative)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm text-muted-foreground">
                            {log.trigger_event} ·{" "}
                            {stepCount === 1
                              ? t("step", { count: 1 })
                              : t("stepPlural", { count: stepCount })}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <StatusBadge status={log.status} t={t} />
                            <ChevronDown
                              className={cn(
                                "size-4 text-muted-foreground transition-transform",
                                isOpen && "rotate-180",
                              )}
                            />
                          </span>
                        </div>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="mx-3 mt-1 mb-3 rounded-xl bg-surface px-4 py-3 sm:ml-[68px]">
                        {log.error_message && (
                          <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                            {log.error_message}
                          </p>
                        )}
                        <ul className="flex flex-col gap-2">
                          {(log.steps_executed ?? []).map((r, i) => (
                            <StepRow key={i} result={r} />
                          ))}
                          {(log.steps_executed ?? []).length === 0 && (
                            <li className="text-[13px] text-muted-foreground">{t("noSteps")}</li>
                          )}
                        </ul>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status, t }: { status: AutomationLog["status"], t: ReturnType<typeof useTranslations> }) {
  return (
    <WaStatusPill
      tone={status === "success" ? "active" : status === "partial" ? "warning" : "danger"}
      className="h-6 text-xs"
    >
      {t(`status.${status}`)}
    </WaStatusPill>
  )
}

function StepRow({ result }: { result: AutomationLogStepResult }) {
  const ok = result.status === "success"
  return (
    <li className="flex items-start gap-2.5 text-[13px] leading-5">
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-primary text-primary-foreground" : "bg-destructive text-white",
        )}
        aria-hidden
      >
        {ok ? <Check className="size-3" strokeWidth={3} /> : <X className="size-3" strokeWidth={3} />}
      </span>
      <span className="text-foreground">{result.step_type}</span>
      {result.detail && (
        <span className="truncate text-muted-foreground">— {result.detail}</span>
      )}
    </li>
  )
}
