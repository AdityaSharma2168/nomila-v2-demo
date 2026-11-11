/**
 * cards/kit/WhatMilaCanDo — Me › What Mila can do (decision 16; MILA_WELCOME). Every built capability a card switches
 * on, from GET /api/v1/me/mila/capabilities (routes/milaChoices.ts), each as one row: its glyph, its name, where it
 * stands (On · Paused · Off) and one button.
 *
 *   Off      "Turn on" opens the connect sheet (TurnOnCard ConnectSheet: the three rows, then the registry's consent
 *            words in the pinned foot). Only the sheet's own Turn on records the yes, with the consent version shown.
 *   On       "Pause", and a "Turn off" link.
 *   Paused   "Resume" (straight back on when the consent it said yes to is still current, else the sheet again), and
 *            "Turn off".
 *
 * A per-account capability (draft replies) has one row per connected account it can serve; with none connected it says
 * so and has no button. Every tap goes to POST /api/v1/me/mila/capabilities/:key (recorded via "me", with the choice
 * version the row was drawn with), then the list reads again. While MILA_WELCOME is off the route answers 404 and Me
 * draws nothing, exactly as before.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Bold, BoldType } from "../../../../constants/theme";
import { apiRequest, queryClient } from "../../../../lib/query-client";
import { MilaButton } from "../../../agent/parts";
import { ConnectSheet, type SheetFields } from "./TurnOnCard";

export const ME_CAPABILITIES_KEY = "/api/v1/me/mila/capabilities";

/** One capability as GET /api/v1/me/mila/capabilities answers it. */
export interface MeCapability {
  key: string;
  name: string;
  scope: "athlete" | "per_account";
  consent: { version: string; automatic: string[]; alwaysAsks: string[]; drafts: boolean; onRevoke: "stop_and_keep" | "stop_and_delete" };
  presentation: { headline: string; line: string; glyph: string | null; platform: string | null; sheet: SheetFields["sheet"] } | null;
  accounts: Array<{ accountRef: string; platform: string; label: string; status: string }>;
  choices: Array<{ accountRef: string | null; state: string; version: number; consentVersion: string | null }>;
  /** On until the athlete turns it off (server registry defaultOn): with no choice yet, the row shows on. */
  defaultOn?: boolean;
}

export type ChoiceTo = "enabled" | "paused" | "revoked" | "never";
export type SetMeChoice = (key: string, body: { to: ChoiceTo; accountRef: string | null; expectedVersion: number; consentVersion?: string }) => Promise<boolean>;

export type RowState = "on" | "paused" | "off";
export interface CapabilityRow {
  id: string;
  cap: MeCapability;
  accountRef: string | null;
  /** The account it is for (per account only). */
  accountLabel: string | null;
  state: RowState;
  /** The choice's state as stored (unset when never answered): "Don't offer this again" only from unset or not now. */
  raw: string;
  version: number;
  consentVersion: string | null;
  /** Per account, with no account connected that can serve it. */
  needsAccount: boolean;
}

const stateOf = (raw: string): RowState => (raw === "enabled" ? "on" : raw === "paused" ? "paused" : "off");
const STATE_LINE: Record<RowState, string> = { on: "On", paused: "Paused", off: "Off" };

/** The list's rows: one per athlete-wide capability, one per fitting account for a per-account one. */
export function capabilityRows(caps: readonly MeCapability[]): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  for (const cap of caps) {
    if (cap.scope === "per_account") {
      if (!cap.accounts.length) {
        rows.push({ id: cap.key, cap, accountRef: null, accountLabel: null, state: "off", raw: "unset", version: 0, consentVersion: null, needsAccount: true });
        continue;
      }
      for (const a of cap.accounts) {
        const c = cap.choices.find((x) => x.accountRef === a.accountRef);
        const raw = c?.state ?? "unset";
        rows.push({ id: `${cap.key}:${a.accountRef}`, cap, accountRef: a.accountRef, accountLabel: a.label, state: stateOf(raw), raw, version: c?.version ?? 0, consentVersion: c?.consentVersion ?? null, needsAccount: false });
      }
      continue;
    }
    const c = cap.choices.find((x) => x.accountRef == null);
    const raw = c?.state ?? "unset";
    rows.push({ id: cap.key, cap, accountRef: null, accountLabel: null, state: raw === "unset" && cap.defaultOn ? "on" : stateOf(raw), raw, version: c?.version ?? 0, consentVersion: c?.consentVersion ?? null, needsAccount: false });
  }
  return rows;
}

/** The sheet's fields for a row: its presentation, the registry's consent words, the service mark or the glyph. */
export function sheetFieldsOf(cap: MeCapability): SheetFields | null {
  const p = cap.presentation;
  if (!p) return null;
  return {
    media: { kind: p.platform ? "platform_mark" : "atmosphere", url: null, mediaId: null, atmosphereId: null, brand: null, platform: p.platform, chart: null, hasFace: false, alt: p.headline },
    headline: p.headline,
    glyph: p.glyph,
    sheet: p.sheet,
    consent: { reads: cap.consent.automatic, drafts: cap.consent.drafts, alwaysAsks: cap.consent.alwaysAsks, onRevoke: cap.consent.onRevoke },
  } as SheetFields;
}

export function useMeCapabilities() {
  return useQuery<{ capabilities: MeCapability[] }>({
    queryKey: [ME_CAPABILITIES_KEY],
    staleTime: 30_000,
    retry: false,
    queryFn: async () => (await (await apiRequest("GET", ME_CAPABILITIES_KEY)).json()) as { capabilities: MeCapability[] },
  });
}

/** Me's own tap: the Welcome registry's route, recorded via "me"; then the list reads again. */
export const setChoiceInMe: SetMeChoice = async (key, body) => {
  try {
    await apiRequest("POST", `${ME_CAPABILITIES_KEY}/${encodeURIComponent(key)}`, body);
    return true;
  } catch {
    return false;
  } finally {
    await queryClient.invalidateQueries({ queryKey: [ME_CAPABILITIES_KEY] });
  }
};

const SAVE_FAILED = "That didn't save. Try again.";

function Row({ row, setChoice, initialSheet = false }: { row: CapabilityRow; setChoice: SetMeChoice; initialSheet?: boolean }) {
  const [sheet, setSheet] = useState(initialSheet);
  const [busy, setBusy] = useState<ChoiceTo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const f = sheetFieldsOf(row.cap);
  const title = row.cap.presentation?.headline ?? row.cap.name;
  const glyph = (row.cap.presentation?.glyph ?? "zap") as React.ComponentProps<typeof Feather>["name"];

  const send = async (to: ChoiceTo, withConsent: boolean) => {
    if (busy) return false;
    setBusy(to);
    setError(null);
    const ok = await setChoice(row.cap.key, {
      to, accountRef: row.accountRef, expectedVersion: row.version, ...(withConsent ? { consentVersion: row.cap.consent.version } : {}),
    }).catch(() => false);
    setBusy(null);
    if (!ok) setError(SAVE_FAILED);
    return ok;
  };
  const turnOnFromSheet = async () => { if (await send("enabled", true)) setSheet(false); };
  // Resume straight back on only when the yes it paused was to today's words; otherwise the sheet shows them again.
  const resume = () => (row.consentVersion === row.cap.consent.version ? void send("enabled", true) : setSheet(true));
  const canSayNever = row.raw === "unset" || row.raw === "not_now";

  const meta = [STATE_LINE[row.state], row.accountLabel].filter(Boolean).join(" · ");
  return (
    <View style={s.row} testID={`me-can-do-${row.id}`}>
      <View style={s.glyph}><Feather name={glyph} size={18} color={Bold.ink} /></View>
      <View style={s.text}>
        <Text style={s.title} numberOfLines={2}>{title}</Text>
        {row.needsAccount
          ? <Text style={s.meta}>Connect an inbox or Instagram first</Text>
          : <Text style={[s.meta, row.state === "on" && s.metaOn]} testID={`me-can-do-${row.id}-state`}>{meta}</Text>}
        {row.state !== "off" ? (
          <Pressable onPress={() => void send("revoked", false)} accessibilityRole="button" accessibilityLabel={`Turn off ${title}`} hitSlop={8}
            style={s.offLink} testID={`me-can-do-${row.id}-off`}>
            <Text style={s.offText}>{busy === "revoked" ? "Turning off…" : "Turn off"}</Text>
          </Pressable>
        ) : null}
        {error && !sheet ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}
      </View>
      {row.needsAccount ? null : row.state === "off" ? (
        <MilaButton tone="soft" label="Turn on" onPress={() => { setError(null); setSheet(true); }} style={s.btn}
          accessibilityLabel={`Turn on ${title}`} testID={`me-can-do-${row.id}-on`} />
      ) : row.state === "on" ? (
        <MilaButton tone="soft" label="Pause" onPress={() => void send("paused", false)} loading={busy === "paused"} style={s.btn}
          accessibilityLabel={`Pause ${title}`} testID={`me-can-do-${row.id}-pause`} />
      ) : (
        <MilaButton tone="soft" label="Resume" onPress={resume} loading={busy === "enabled" && !sheet} style={s.btn}
          accessibilityLabel={`Resume ${title}`} testID={`me-can-do-${row.id}-resume`} />
      )}
      {f ? (
        <ConnectSheet visible={sheet} f={f} busy={busy === "enabled"} error={sheet ? error : null}
          onTurnOn={() => void turnOnFromSheet()}
          onNotNow={() => setSheet(false)}
          onNever={canSayNever ? () => { void send("never", false).then((ok) => { if (ok) setSheet(false); }); } : undefined}
          onClose={() => setSheet(false)} />
      ) : null}
    </View>
  );
}

export function WhatMilaCanDo({ capabilities, setChoice = setChoiceInMe, openSheetFor }: {
  capabilities: readonly MeCapability[];
  setChoice?: SetMeChoice;
  /** The gallery: a row id whose sheet starts open (a screenshot of the sheet). */
  openSheetFor?: string;
}) {
  const rows = capabilityRows(capabilities);
  if (!rows.length) return null;
  return (
    <View style={s.wrap} testID="me-what-mila-can-do">
      <Text style={s.head} accessibilityRole="header">What Mila can do</Text>
      <Text style={s.lede}>Turn things on, pause them or turn them off. Nothing goes out without your tap.</Text>
      <View style={s.list}>
        {/* Keyed on the choice version: after a tap the list reads again and the row starts from its new state. */}
        {rows.map((r) => <Row key={`${r.id}:${r.version}`} row={r} setChoice={setChoice} initialSheet={r.id === openSheetFor} />)}
      </View>
    </View>
  );
}

/** As the Me screens mount it: reads the route; draws nothing while it loads, fails or is off (404). */
export function MeWhatMilaCanDo({ style }: { style?: object }) {
  const q = useMeCapabilities();
  const caps = q.data?.capabilities ?? [];
  if (!caps.length) return null;
  return <View style={style}><WhatMilaCanDo capabilities={caps} /></View>;
}

const s = StyleSheet.create({
  wrap: { gap: 6 },
  head: { ...BoldType.section, color: Bold.ink },
  lede: { ...BoldType.rowMeta, color: Bold.mute },
  list: { marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Bold.line },
  glyph: { width: 40, height: 40, borderRadius: 12, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...BoldType.rowTitle, color: Bold.ink },
  meta: { ...BoldType.caption, color: Bold.mute },
  metaOn: { color: Bold.ink },
  offLink: { alignSelf: "flex-start", marginTop: 2 },
  offText: { ...BoldType.caption, color: Bold.ink, textDecorationLine: "underline" },
  error: { ...BoldType.caption, color: Bold.act },
  btn: { height: Bold.buttonSmall, borderRadius: Bold.buttonSmall / 2, paddingHorizontal: 14 },
});
