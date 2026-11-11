// BrandSections — the brand page's deals (docs/design/brand-page-deals.md). One collapsible section per deal with
// this brand: its status, what's next, ONE primary action, its paperwork timeline and its conversation. The section
// that needs her opens; the rest are collapsed. Every line is a derived field — no email text, no subjects.
import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, Fonts } from "../../constants/theme";
import type { BrandPage, BrandSection } from "../../hooks/use-brand-page";
import { actionEmphasis } from "./oppBoardLogic";

interface Props {
  page: BrandPage;
  busy: boolean;
  onPrimary: (s: BrandSection) => void;
  onConfirmSigned: (s: BrandSection) => void;
  onReadContract: (s: BrandSection) => void;
  onOpenThread: (threadId: string) => void;
  onOpenFile: (s: BrandSection, f: { message_id: string; index: number }) => void;
  /** PR 3: "This is a separate deal". Absent → not offered. */
  onSplit?: (s: BrandSection, chainId?: string) => void;
}

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;

/** The timeline's heading: "Paperwork" when it is all paperwork, "Calls" when it is all calls, else "Timeline". */
export function timelineTitle(rows: Array<{ event: string }>): string {
  const calls = rows.filter((r) => r.event === "meeting").length;
  return calls === 0 ? "Paperwork" : calls === rows.length ? "Calls" : "Timeline";
}

/** Plain words for why "Looks signed" shows (evidence kinds, never email text). */
export function sectionSignedWhy(s: Pick<BrandSection, "signed_evidence">): string {
  const kinds = new Set(s.signed_evidence.map((e) => e.kind));
  if (kinds.has("paperwork") || kinds.has("legacy_esign")) return "An e-signature email says every party has signed.";
  if (kinds.has("attachment")) return "A signed copy of the agreement arrived by email.";
  return "The conversation reads like a signed agreement.";
}

/**
 * The section header's dates: when the deal started (its first message) and, once signed, when it was signed. Last
 * activity stays on the conversation row ("last …"); an older server without started_at falls back to it.
 */
export function sectionMeta(s: Pick<BrandSection, "opportunity_status" | "started_at" | "signed" | "last_activity_at">): string {
  const started = fmtDate(s.started_at);
  return [
    s.opportunity_status === "won" ? "Closed as won" : null,
    started ? `Started ${started}` : fmtDate(s.last_activity_at),
    s.signed ? `Signed ${fmtDate(s.signed.at)}` : null,
  ].filter(Boolean).join(" · ");
}

function SectionCard({ s, open, onToggle, ...p }: Omit<Props, "page"> & { s: BrandSection; open: boolean; onToggle: () => void }) {
  const [signedDismissed, setSignedDismissed] = useState(false);
  const [readDismissed, setReadDismissed] = useState(false);
  const meta = sectionMeta(s);
  // A closed deal is history: no "What's next", no reply. Anything new from the brand is a new deal.
  const closed = s.read_only ?? s.opportunity_status !== "open";
  return (
    <View style={[styles.card, s.needs_her && !closed && styles.cardNeeds]}>
      {/* Labels on one line, dates on their own line under them: side by side, a long date line squeezed the labels. */}
      <Pressable onPress={onToggle} style={styles.headCol} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View style={styles.head}>
          <View style={styles.chips}>
            {s.label ? <View style={[styles.chip, s.label === "Signed" && styles.chipDark]}><Text style={[styles.chipT, s.label === "Signed" && { color: Bold.onDark }]}>{s.label}</Text></View> : null}
            {s.pitched_by_you ? <View style={styles.chip}><Text style={styles.chipT}>Pitched by you</Text></View> : null}
            {s.needs_her && !closed ? <View style={[styles.chip, styles.chipBlue]}><Text style={[styles.chipT, { color: Bold.onDark }]}>Needs you</Text></View> : null}
          </View>
          <Feather name={open ? "chevron-up" : "chevron-down"} size={18} color={Bold.quiet} />
        </View>
        {meta ? <Text style={styles.caption}>{meta}</Text> : null}
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {s.looks_signed && !signedDismissed ? (
            <View style={styles.prompt}>
              <View style={styles.promptHead}><Feather name="file-text" size={15} color={Bold.ink} /><Text style={styles.promptT}>Looks signed — confirm?</Text></View>
              <Text style={styles.text}>{sectionSignedWhy(s)} Nothing changes until you confirm.</Text>
              <View style={styles.pair}>
                <Pressable style={[styles.smallBtn, styles.smallBtnDark]} disabled={p.busy} onPress={() => p.onConfirmSigned(s)} accessibilityRole="button"><Text style={styles.smallBtnDarkT}>Yes, it’s signed</Text></Pressable>
                <Pressable style={styles.smallBtn} onPress={() => setSignedDismissed(true)} accessibilityRole="button"><Text style={styles.smallBtnT}>Not yet</Text></Pressable>
              </View>
            </View>
          ) : null}

          {s.signed && !s.has_contract && s.contract_candidate && !readDismissed ? (
            <View style={styles.prompt}>
              <View style={styles.promptHead}><Feather name="file-text" size={15} color={Bold.ink} /><Text style={styles.promptT}>Read the signed contract into your terms?</Text></View>
              <Text style={styles.text}>{`${s.contract_candidate.filename}. Nomila reads it and you check every figure before anything is saved.`}</Text>
              <View style={styles.pair}>
                <Pressable style={[styles.smallBtn, styles.smallBtnDark]} disabled={p.busy} onPress={() => p.onReadContract(s)} accessibilityRole="button"><Text style={styles.smallBtnDarkT}>Read it</Text></Pressable>
                <Pressable style={styles.smallBtn} onPress={() => setReadDismissed(true)} accessibilityRole="button"><Text style={styles.smallBtnT}>Later</Text></Pressable>
              </View>
            </View>
          ) : null}

          {!closed ? <>
          <Text style={styles.h4}>What’s next</Text>
          <Text style={styles.text}>{s.take}</Text>
          {/* One primary per card, from the deal state: "Yes, it’s signed" while that prompt is up, else this action. */}
          {actionEmphasis(s.looks_signed, signedDismissed) === "primary" ? (
            <Pressable style={styles.primary} disabled={p.busy} onPress={() => p.onPrimary(s)} accessibilityRole="button" testID={`section-action-${s.deal_id}`}>
              <Text style={styles.primaryT}>{s.primary.label}</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.demoted} disabled={p.busy} onPress={() => p.onPrimary(s)} accessibilityRole="button" testID={`section-action-${s.deal_id}`}>
              <Text style={styles.demotedT}>{s.primary.label}</Text>
            </Pressable>
          )}
          </> : null}

          {s.paperwork.length ? (
            <View style={styles.block}>
              <Text style={styles.eyebrow}>{timelineTitle(s.paperwork)}</Text>
              {s.paperwork.map((r) => (
                <View key={r.thread_id} style={styles.pwRow}>
                  <View style={styles.pwDot} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.rowT}>{r.label}</Text>
                    <Text style={styles.caption}>{r.event === "meeting" ? `Invite received ${fmtDate(r.at) ?? ""}`.trim() : fmtDate(r.at) ?? ""}</Text>
                    {/* The email it came from (a payment notice, a signature email): open it where she reads mail. */}
                    <Pressable onPress={() => p.onOpenThread(r.thread_id)} hitSlop={6} style={styles.file} accessibilityRole="link" testID={`pw-email-${r.thread_id}`}>
                      <Feather name="mail" size={13} color={Bold.blue} />
                      <Text style={styles.fileT} numberOfLines={1}>Open the email</Text>
                    </Pressable>
                    {r.files.map((f) => (
                      <Pressable key={`${f.message_id}-${f.index}`} onPress={() => p.onOpenFile(s, f)} hitSlop={6} style={styles.file} accessibilityRole="link">
                        <Feather name="paperclip" size={13} color={Bold.blue} />
                        <Text style={styles.fileT} numberOfLines={1}>{f.filename}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {s.conversation ? (
            <View style={styles.block}>
              <Pressable style={styles.row} onPress={() => p.onOpenThread(s.conversation!.thread_id)} accessibilityRole="button">
                <Feather name="message-circle" size={18} color={Bold.ink2} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowT}>Conversation</Text>
                  <Text style={styles.caption}>{`${s.conversation.message_count} message${s.conversation.message_count === 1 ? "" : "s"} · last ${fmtDate(s.conversation.last_at) ?? "—"} · read live from your inbox`}</Text>
                </View>
                <Feather name="chevron-right" size={18} color={Bold.quiet} />
              </Pressable>
              {s.conversation.chains.filter((c) => !c.main).map((c) => (
                <View key={c.chain_id} style={styles.chain}>
                  <Text style={styles.caption}>
                    {`Another email chain folded in · ${c.message_count} message${c.message_count === 1 ? "" : "s"} from ${fmtDate(c.first_at) ?? "—"}${c.first_direction === "outbound" ? " · you wrote first" : ""}`}
                  </Text>
                  {p.onSplit ? (
                    <Pressable onPress={() => p.onSplit!(s, c.chain_id)} hitSlop={6} accessibilityRole="button"><Text style={styles.link}>This is a separate deal</Text></Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          {p.onSplit && s.shares_opportunity && s.opportunity_status === "open" ? (
            <View style={styles.links}>
              <Pressable onPress={() => p.onSplit!(s)} hitSlop={8} accessibilityRole="button"><Text style={styles.secondaryT}>This is a separate deal</Text></Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function BrandSections({ page, ...p }: Props) {
  const [openId, setOpenId] = useState<string | null>(page.open_section);
  return (
    <View style={styles.wrap}>
      <Text style={styles.eyebrow}>{`${page.sections.length} deals with ${page.brand.name}`}</Text>
      {page.sections.map((s) => (
        <SectionCard key={s.deal_id} s={s} open={openId === s.deal_id} onToggle={() => setOpenId(openId === s.deal_id ? null : s.deal_id)} {...p} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:        { gap: 12 },
  card:        { borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, padding: 12, gap: 10 },
  cardNeeds:   { borderColor: Bold.ink, borderWidth: 1.5 },
  headCol:     { gap: 6 },
  head:        { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  chips:       { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip:        { borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.chip, paddingHorizontal: 7, paddingVertical: 4 },
  chipDark:    { backgroundColor: Bold.ink },
  chipBlue:    { backgroundColor: Bold.blue, borderColor: Bold.blue },
  chipT:       { fontFamily: "Outfit_900Black", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: Bold.ink },
  body:        { gap: 10 },
  prompt:      { borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.card, padding: 12, gap: 8 },
  promptHead:  { flexDirection: "row", alignItems: "center", gap: 8 },
  promptT:     { fontFamily: Fonts.bodyBold, fontSize: 15, color: Bold.ink },
  pair:        { flexDirection: "row", gap: 8 },
  smallBtn:    { flex: 1, height: Bold.buttonSmall, borderRadius: Bold.radius.pill, borderWidth: 1.5, borderColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  smallBtnDark:{ backgroundColor: Bold.act, borderColor: Bold.act },
  smallBtnT:   { fontFamily: "Outfit_800ExtraBold", fontSize: 12, letterSpacing: 0.9, textTransform: "uppercase", color: Bold.ink },
  smallBtnDarkT:{ fontFamily: "Outfit_800ExtraBold", fontSize: 12, letterSpacing: 0.9, textTransform: "uppercase", color: Bold.onAct },
  h4:          { fontFamily: Fonts.bodyBold, fontSize: 15, color: Bold.ink },
  text:        { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: Bold.ink },
  primary:     { height: Bold.button, borderRadius: Bold.radius.pill, backgroundColor: Bold.act, alignItems: "center", justifyContent: "center" },
  primaryT:    { fontFamily: "Outfit_900Black", fontSize: 15, letterSpacing: 1, textTransform: "uppercase", color: Bold.onAct },
  demoted:     { height: Bold.button, borderRadius: Bold.radius.pill, borderWidth: 2, borderColor: Bold.ink, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center" },
  demotedT:    { fontFamily: "Outfit_900Black", fontSize: 15, letterSpacing: 1, textTransform: "uppercase", color: Bold.ink },
  block:       { gap: 8 },
  eyebrow:     { fontFamily: "Outfit_900Black", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: Bold.mute },
  pwRow:       { flexDirection: "row", gap: 10 },
  pwDot:       { width: 7, height: 7, borderRadius: 4, backgroundColor: Bold.ink, marginTop: 6 },
  file:        { flexDirection: "row", alignItems: "center", gap: 6 },
  fileT:       { flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Bold.blue },
  row:         { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, padding: 12 },
  rowT:        { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Bold.ink },
  caption:     { fontFamily: Fonts.body, fontSize: 12, color: Bold.mute },
  chain:       { gap: 4, paddingLeft: 4 },
  link:        { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Bold.blue },
  links:       { flexDirection: "row", gap: 24, justifyContent: "center" },
  secondaryT:  { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Bold.ink2, textDecorationLine: "underline" },
});
