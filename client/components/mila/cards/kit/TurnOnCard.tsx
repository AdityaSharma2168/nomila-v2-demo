/**
 * cards/kit/TurnOnCard — one capability offered at the moment it matters (design v2.2 "Turn-on offer"). Collapsed: a
 * tall card (atmosphere + the capability's glyph, or the service's mark), "Mila can do more", the name, ONE soft
 * "Set it up". A tap anywhere opens the CONNECT SHEET (Muse's pattern, in our light palette). Its BODY scrolls: a drag
 * handle, the big mark, the name, one purpose line, three rows (what it does · what you control · what can go wrong).
 * Its FOOT is pinned (consent design rev. 2, owner 5 Nov 2026): the CONSENT BLOCK (the registry's own words, verbatim,
 * under "Once it's on, Mila will" for consent.reads and "Always asks you first" for consent.alwaysAsks; never cut, an
 * empty group not drawn), then the legal line with "Don't offer this again", one full-width raspberry Turn on and a
 * text-link "Not now". So the words a yes records are on screen whenever its button is. "Set it up" turns nothing on:
 * only the sheet's button does, because the consent has to be seen first (decision 4). At most 2 + 2 consent lines
 * (TURN_ON_CONSENT_MAX), which keeps the foot near 60% of a 375x667 phone.
 */
import React, { useContext, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import type { MilaCardDto } from "../../../../../shared/milaCards";
import { Bold, BoldType } from "../../../../constants/theme";
import { MilaButton } from "../../../agent/parts";
import { LogoMark } from "../../../ui/LogoMark";
import { useCardHost, useSeen } from "./host";
import { CardBody, CardFrame, CardMedia, Receipt, styles } from "./parts";

type TurnOn = Extract<MilaCardDto, { type: "turn-on" }>["data"];
type Fields = TurnOn["fields"];
/** What the connect sheet draws: the chat card's fields, or Me's capability row (GET /me/mila/capabilities). */
export type SheetFields = Pick<Fields, "media" | "headline" | "sheet" | "consent" | "glyph">;

/** How a card already answered reads (a reopened chat, Me's list). */
const TURN_ON_STATE_LINE: Partial<Record<Fields["state"], string>> = {
  enabled: "On. Turn it off any time in Me.",
};

export function TurnOnCard({ data, initialSheet = false, onTurnOff }: {
  data: TurnOn; initialSheet?: boolean;
  /** Me › What Mila can do only: a capability that is on gets a soft "Turn off" (POST /me/mila/capabilities/:key). */
  onTurnOff?: () => Promise<boolean>;
}) {
  const f = data.fields;
  const host = useCardHost();
  const [sheet, setSheet] = useState(initialSheet);
  const [receipt, setReceipt] = useState<string | null>(TURN_ON_STATE_LINE[f.state] ?? null);
  const [turningOff, setTurningOff] = useState(false);
  const turnOff = async () => {
    if (!onTurnOff || turningOff) return;
    setTurningOff(true);
    const ok = await onTurnOff().catch(() => false);
    if (!ok) setTurningOff(false);
  };
  useSeen("turn-on", f.decisionId);
  const answer = async (outcome: "accepted" | "not_now" | "never") => {
    // Only the sheet's own button sends a Turn on, with the consent version the sheet showed (decision 4).
    const r = await host.record({ card: "turn-on", ref: f.decisionId, outcome, ...(outcome === "accepted" ? { action: "enabled" as const, consentVersion: f.consentVersion } : {}) });
    if (r == null) return;
    setSheet(false);
    setReceipt(r || (outcome === "accepted" ? "On." : "OK."));
  };
  const glyph = (f.glyph ?? "zap") as React.ComponentProps<typeof Feather>["name"];
  return (
    <CardFrame testID="card-turn-on">
      <CardBody onPress={receipt ? undefined : () => setSheet(true)} label={`${f.headline}, set it up`}>
        <CardMedia media={f.media} shape="promo" kindLabel="Mila can do more" faceKey={data.id} glyph={glyph}
          overlay={f.media.kind === "atmosphere" && f.media.url ? <View style={styles.center}><View style={styles.glyphTile}><Feather name={glyph} size={24} color={Bold.ink} /></View></View> : null} />
        <View style={[styles.body, { gap: 10 }]}>
          <Text style={styles.headline} numberOfLines={3}>{f.headline}</Text>
        </View>
      </CardBody>
      <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
        {receipt ? (
          <View style={{ gap: 10 }}>
            <Receipt line={receipt} />
            {onTurnOff && f.state === "enabled" ? (
              <MilaButton tone="soft" label="Turn off" onPress={() => void turnOff()} loading={turningOff} style={styles.fullBtn}
                accessibilityLabel={`Turn off ${f.headline}`} testID="card-turn-on-off" />
            ) : null}
          </View>
        ) : <MilaButton tone="soft" label="Set it up" onPress={() => setSheet(true)} style={styles.fullBtn} testID="card-turn-on-setup" />}
      </View>
      <ConnectSheet visible={sheet} f={f} onTurnOn={() => void answer("accepted")} onNotNow={() => void answer("not_now")} onNever={() => void answer("never")} onClose={() => setSheet(false)} />
    </CardFrame>
  );
}

/** The consent block: the registry's words for the version the tap records, verbatim (consentWords via the DTO). */
export function ConsentBlock({ consent }: { consent: Fields["consent"] }) {
  const group = (label: string, lines: string[], icon: "check" | "lock", testID: string) => lines.length ? (
    <View style={s.group} testID={testID}>
      <Text style={s.groupLabel}>{label}</Text>
      {lines.map((line, i) => (
        <View key={`${i}:${line}`} style={s.item}>
          <Feather name={icon} size={14} color={Bold.ink} style={s.itemIcon} />
          <Text style={s.itemText}>{line}</Text>
        </View>
      ))}
    </View>
  ) : null;
  const reads = group("Once it's on, Mila will", consent.reads, "check", "connect-sheet-consent-reads");
  const asks = group("Always asks you first", consent.alwaysAsks, "lock", "connect-sheet-consent-asks");
  if (!reads && !asks) return null;
  return (
    <View style={s.consent} testID="connect-sheet-consent">
      {reads}
      {reads && asks ? <View style={s.sep} /> : null}
      {asks}
    </View>
  );
}

export function ConnectSheet({ visible, f, onTurnOn, onNotNow, onNever, onClose, inline = false, busy = false, error = null }: {
  visible: boolean; f: SheetFields; onTurnOn: () => void; onNotNow: () => void;
  /** "Don't offer this again"; left out where it cannot apply (Me, for a capability paused or turned off). */
  onNever?: () => void;
  onClose: () => void;
  /** The gallery draws the sheet in the page (no Modal), so a screenshot shows it. */
  inline?: boolean;
  /** Me: the Turn on is saving (the button shows it), or did not save (one plain line above the button). */
  busy?: boolean;
  error?: string | null;
}) {
  const { height } = useWindowDimensions();
  // The foot clears the home indicator / gesture bar (the Modal draws edge to edge); null without a provider (tests).
  const bottomInset = useContext(SafeAreaInsetsContext)?.bottom ?? 0;
  const glyph = (f.glyph ?? "zap") as React.ComponentProps<typeof Feather>["name"];
  const body = (
    <View style={[s.sheet, !inline && { maxHeight: Math.round(height * 0.92) }]} testID="connect-sheet" accessibilityViewIsModal>
      <ScrollView style={s.scroll} contentContainerStyle={s.body} testID="connect-sheet-body" bounces={false}>
        <View style={s.handle} />
        <View style={s.bigMark}>
          {f.media.kind === "platform_mark" ? <LogoMark platform={f.media.platform ?? null} name={f.headline} size={56} /> : <Feather name={glyph} size={28} color={Bold.ink} />}
        </View>
        <Text style={s.name} accessibilityRole="header">{f.headline}</Text>
        <Text style={s.purpose}>{f.sheet.purpose}</Text>
        <View style={s.rows}>
          {f.sheet.rows.map((r) => (
            <View key={r.title} style={s.row}>
              <Feather name={r.icon as React.ComponentProps<typeof Feather>["name"]} size={20} color={Bold.ink} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={s.rowTitle}>{r.title}</Text>
                <Text style={s.rowLine}>{r.line}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
      <View style={[s.foot, !inline && bottomInset > 0 && { paddingBottom: Math.max(20, bottomInset + 8) }]} testID="connect-sheet-foot">
        <ConsentBlock consent={f.consent} />
        <Text style={s.legal}>
          {f.sheet.legal}
          {onNever ? <>{" "}<Text style={s.legalLink} onPress={onNever} accessibilityRole="link" testID="connect-sheet-never">Don't offer this again</Text></> : null}
        </Text>
        {error ? <Text style={s.error} accessibilityRole="alert" testID="connect-sheet-error">{error}</Text> : null}
        <MilaButton tone="primary" label={f.sheet.button} onPress={onTurnOn} loading={busy} style={styles.fullBtn} testID="connect-sheet-turn-on" />
        <Pressable onPress={onNotNow} accessibilityRole="button" accessibilityLabel="Not now" hitSlop={10}
          style={({ pressed }) => [s.notNow, pressed && styles.pressed]} testID="connect-sheet-not-now">
          <Text style={s.notNowText}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
  if (inline) return visible ? <View style={s.inlineWrap}><View style={s.dim} />{body}</View> : null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Close" />
      {body}
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: Bold.sheetScrim },
  inlineWrap: { borderRadius: 28, overflow: "hidden", backgroundColor: Bold.paper },
  dim: { height: 96, backgroundColor: "rgba(14,14,14,0.34)" },
  sheet: {
    backgroundColor: Bold.paper, borderTopLeftRadius: Bold.sheetRadius, borderTopRightRadius: Bold.sheetRadius, marginTop: -8, overflow: "hidden",
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { paddingTop: 10, paddingHorizontal: 20, paddingBottom: 12, gap: 12 },
  foot: { paddingTop: 12, paddingHorizontal: 20, paddingBottom: 20, gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },
  handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: Bold.line, alignSelf: "center" },
  bigMark: { alignSelf: "center", width: 64, height: 64, borderRadius: 18, backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, alignItems: "center", justifyContent: "center", marginTop: 6, overflow: "hidden" },
  name: { ...BoldType.headedTitle, textAlign: "center", color: Bold.ink },
  purpose: { ...BoldType.cardLine, textAlign: "center", color: Bold.mute, marginTop: -6 },
  rows: { gap: 14, marginTop: 4 },
  row: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  rowTitle: { ...BoldType.rowTitle, color: Bold.ink },
  rowLine: { ...BoldType.cardMeta, fontSize: 13, lineHeight: 18, color: Bold.mute },
  consent: { backgroundColor: Bold.ground, borderRadius: Bold.radius.card, paddingTop: 12, paddingBottom: 14, paddingHorizontal: 14, gap: 10 },
  group: { gap: 6 },
  groupLabel: { ...BoldType.label, color: Bold.mute },
  item: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  itemIcon: { marginTop: 3 },
  itemText: { ...BoldType.cardLine, color: Bold.ink2, flex: 1 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: Bold.line },
  legal: { ...BoldType.caption, fontSize: 11.5, textAlign: "center", color: Bold.mute },
  legalLink: { color: Bold.ink, textDecorationLine: "underline" },
  error: { ...BoldType.caption, textAlign: "center", color: Bold.act },
  notNow: { alignSelf: "center", minHeight: 24, justifyContent: "center", paddingHorizontal: 12 },
  notNowText: { ...BoldType.link, color: Bold.ink },
});
