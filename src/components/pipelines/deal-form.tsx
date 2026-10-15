"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES } from "@/lib/currency";
import type {
  Contact,
  Conversation,
  Deal,
  DealStatus,
  PipelineStage,
  Profile,
} from "@/types";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CalendarDays,
  Check,
  ChevronRight,
  Columns3,
  DollarSign,
  Flag,
  Loader2,
  MessageSquare,
  RotateCcw,
  StickyNote,
  Trash2,
  UserCheck,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "next-intl";
import { formatDateOnlyLong } from "@/components/broadcasts/locale-format";

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  onSaved: () => void;
}

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  onSaved,
}: DealFormProps) {
  const t = useTranslations("Pipelines.form");
  const tUi = useTranslations("UiPrimitives");
  const locale = useLocale();
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [notes, setNotes] = useState("");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ""));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? "");
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? "");
      setExpectedCloseDate(deal.expected_close_date ?? "");
      setNotes(deal.notes ?? "");
    } else {
      setTitle("");
      setValue("");
      setCurrency(defaultCurrency);
      setContactId("");
      setStageId(defaultStageId || stages[0]?.id || "");
      setAssignedTo("");
      setExpectedCloseDate("");
      setNotes("");
    }
  }, [open, deal, defaultStageId, stages, defaultCurrency]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load supporting data once the sheet is open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [c, p] = await Promise.all([
        supabase.from("contacts").select("*").order("name"),
        supabase.from("profiles").select("*").order("full_name"),
      ]);
      if (cancelled) return;
      setContacts((c.data ?? []) as Contact[]);
      setProfiles((p.data ?? []) as Profile[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLinkedConversation((data as Conversation | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  async function handleSave() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error(t("toastRequired"));
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
    };

    if (deal) {
      const { error } = await supabase
        .from("deals")
        .update(payload)
        .eq("id", deal.id);
      if (error) {
        toast.error(t("toastFailedSave"));
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t("toastNotSignedIn"));
        setSaving(false);
        return;
      }
      if (!accountId) {
        toast.error(t("toastNotLinked"));
        setSaving(false);
        return;
      }
      const { error } = await supabase
        .from("deals")
        .insert({ ...payload, user_id: user.id, account_id: accountId, status: "open" });
      if (error) {
        toast.error(t("toastFailedCreate"));
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(deal ? t("toastUpdated") : t("toastCreated"));
    onOpenChange(false);
    onSaved();
  }

  async function handleStatusChange(status: DealStatus) {
    if (!deal) return;
    setStatusAction(status);
    const { error } = await supabase
      .from("deals")
      .update({ status })
      .eq("id", deal.id);
    setStatusAction(null);
    if (error) {
      toast.error(t("toastFailedStatus"));
      return;
    }
    toast.success(
      status === "won" ? t("toastMarkedWon") : status === "lost" ? t("toastMarkedLost") : t("toastReopened"),
    );
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await supabase.from("deals").delete().eq("id", deal.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    toast.success(t("toastDeleted"));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* WA "contact info" drawer: 64px header with X + title, sections
          on app bg separated by rail-coloured gaps, footer actions. */}
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-0 border-l border-border bg-rail p-0 sm:max-w-[440px]"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="h-16 shrink-0 flex-row items-center gap-4 bg-background px-4 py-0">
            <SheetClose
              render={
                <button
                  type="button"
                  aria-label={tUi("close")}
                  className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-hover-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <X className="size-5" />
            </SheetClose>
            <SheetTitle className="truncate text-base font-normal">
              {deal ? t("editDeal") : t("newDeal")}
            </SheetTitle>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            <section className="space-y-4 bg-background px-6 pt-4 pb-6">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("title")}</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("titlePlaceholder")}
                />
              </div>

              <div className="grid grid-cols-[1fr_110px] gap-3">
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("value")}</Label>
                  <div className="relative">
                    <DollarSign className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      type="number"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder="0"
                      className="pl-9"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label className="text-muted-foreground">{t("currency")}</Label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className={SELECT_CLASS}
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("expectedCloseDate")}</Label>
                <Input
                  type="date"
                  value={expectedCloseDate}
                  onChange={(e) => setExpectedCloseDate(e.target.value)}
                />
                {/* The native date input renders in the BROWSER's locale
                    (e.g. 10/18/2026); echo the date in the app locale. */}
                {expectedCloseDate && (
                  <p className="flex items-center gap-1.5 px-1 text-[13px] text-muted-foreground">
                    <CalendarDays className="size-3.5" />
                    {formatDateOnlyLong(expectedCloseDate, locale)}
                  </p>
                )}
              </div>
            </section>

            <section className="space-y-3 bg-background px-6 py-4">
              <SectionLabel icon={UserRound}>{t("contact")}</SectionLabel>
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">{t("selectContact")}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.phone}
                  </option>
                ))}
              </select>

              {linkedConversation && (
                <Link
                  href="/inbox"
                  className="flex items-center gap-3 rounded-xl bg-chip-active px-3 py-2.5 text-sm text-chip-active-foreground transition-opacity hover:opacity-90"
                >
                  <MessageSquare className="size-4 shrink-0" />
                  <span className="flex-1">{t("linkToConversation")}</span>
                  <ChevronRight className="size-4 shrink-0 opacity-70" />
                </Link>
              )}
            </section>

            <section className="space-y-4 bg-background px-6 py-4">
              <div className="grid gap-2">
                <SectionLabel icon={Columns3}>{t("stage")}</SectionLabel>
                <select
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <SectionLabel icon={UserCheck}>{t("assignedTo")}</SectionLabel>
                <select
                  value={assignedTo}
                  onChange={(e) => setAssignedTo(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">{t("unassigned")}</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name || p.email}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section className="space-y-3 bg-background px-6 py-4">
              <SectionLabel icon={StickyNote}>{t("notes")}</SectionLabel>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                className="min-h-[100px]"
              />
            </section>

            {deal && (
              <section className="space-y-3 bg-background px-6 py-4">
                <SectionLabel icon={Flag}>{t("status")}</SectionLabel>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("won")}
                    disabled={!!statusAction || deal.status === "won"}
                    className="min-w-40 flex-1"
                  >
                    {statusAction === "won" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <>
                        <Check className="size-4" />
                        {t("markAsWon")}
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => handleStatusChange("lost")}
                    disabled={!!statusAction || deal.status === "lost"}
                    className="min-w-40 flex-1"
                  >
                    {statusAction === "lost" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <>
                        <X className="size-4" />
                        {t("markAsLost")}
                      </>
                    )}
                  </Button>
                </div>
                {deal.status && deal.status !== "open" && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStatusChange("open")}
                    disabled={!!statusAction}
                    className="w-full text-muted-foreground"
                  >
                    <RotateCcw className="size-4" />
                    {t("reopenDeal")}
                  </Button>
                )}
              </section>
            )}

            {/* WA "Delete chat" style destructive row at the end of the
                info panel; confirms inline. */}
            {deal && (
              <section className="bg-background px-3 py-2">
                {confirmDelete ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm">
                    <span className="text-destructive">{t("deletePrompt")}</span>
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDelete(false)}
                        disabled={deleting}
                      >
                        {t("cancel")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleDelete}
                        disabled={deleting}
                        className="bg-destructive text-white hover:bg-destructive/90"
                      >
                        {deleting ? t("deleting") : t("confirm")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="flex h-12 w-full items-center gap-5 rounded-xl px-3 text-[15px] text-destructive outline-none transition-colors hover:bg-hover-surface focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="size-5" />
                    {t("deleteDeal")}
                  </button>
                )}
              </section>
            )}
          </div>

          <div className="flex shrink-0 gap-2 bg-background px-6 py-4">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="flex-1"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !title.trim() || !contactId || !stageId}
              className="flex-1"
            >
              {saving ? t("saving") : deal ? t("saveChanges") : t("createDeal")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Native `<select>` styled like the WA `Input` (hover-surface, no border). */
const SELECT_CLASS =
  "h-10 w-full rounded-lg bg-hover-surface px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** WA info-panel section label: muted icon + 14px muted text. */
function SectionLabel({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Icon className="size-4" />
      {children}
    </p>
  );
}
