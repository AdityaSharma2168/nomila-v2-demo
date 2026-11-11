/**
 * KnowsFactsScreen — What Nomila knows, on the agent memory (AGENT_V3; Me's Knows door). Reads GET /me/facts (knows/1,
 * shared/meScouting.ts) and writes through the fact routes (server/routes/meMemory.ts):
 *
 *   the list     every fact about you, grouped (At a glance · Career · Honours · …), each row whole-card tappable: the
 *                claim, where it came from (you told us · found · from your accounts), its date, "couldn't confirm"
 *   a fact       its sheet: sources, then the actions — That's right (confirm) · Change it (your correction becomes the
 *                fact you said) · This isn't right (dispute: Mila asks you what's true) · Hide (undo under Hidden)
 *   private      care facts: only you see these, never in anything shared
 *   hidden       facts you hid, each with Restore
 *
 * A measured fact is fixed at its source (the connected account), so it offers no Change it. An edit re-runs only what
 * used the fact, after a quiet window; the screen says so in plain words. Nothing here is sent anywhere else.
 */
import React, { useState } from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, TextInput, ActivityIndicator, Pressable, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Button, Card, Chip, Eyebrow, Row, RuledHead, SectionHead, StackHeader } from "../../components/ui";
import { DetailSheet } from "../../components/me/DetailSheet";
import { Bold, BoldType } from "../../constants/theme";
import { useFactAction, useMeFacts } from "../../hooks/use-me-memory";
import { openMila } from "../../lib/milaLaunch";
import type { KnowsFact, KnowsSectionKey, Provenance } from "../../../shared/meScouting";

export const KNOWS_COPY = {
  back: "Me",
  title: "What Nomila knows",
  factTitle: "This fact",
  lede: "Everything Nomila holds about you, and where each fact came from. Tap a fact to confirm, change or hide it.",
  counts: (total: number, unconfirmed: number) => [`${total} ${total === 1 ? "fact" : "facts"}`, unconfirmed ? `${unconfirmed} couldn't confirm` : null].filter(Boolean).join(" · "),
  unconfirmed: "Couldn't confirm",
  confirmedByYou: "You confirmed",
  private: "Only you see these",
  hidden: "Hidden",
  restore: "Restore",
  sources: "Where it came from",
  confirm: "That's right",
  change: "Change it",
  save: "Save",
  cancel: "Cancel",
  dispute: "This isn't right",
  hide: "Hide",
  measured: "This number comes from your connected account. Fix it there.",
  rerun: "Saved. Nomila updates what used this fact in about 30 minutes.",
  confirmed: "Thanks. Nomila keeps it as it is.",
  failed: "That didn't go through. Try again.",
  empty: "Nomila hasn't written down any facts about you yet.",
  loadError: "Couldn't load what Nomila knows. Pull down to try again.",
  disputeDraft: (claim: string) => `"${claim}" isn't right. What's true is `,
} as const;

export const SECTION_LABEL: Record<KnowsSectionKey, string> = {
  glance: "At a glance", career: "Career", honours: "Honours", academics: "Academics", brands: "Brands & business",
  media: "Media & audience", interests: "Causes & interests", details: "Details",
};

export const PROVENANCE_WORDS: Record<Provenance, string> = { you: "You told us", found: "Found", accounts: "From your accounts" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = "(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)";
/** A claim that states a full date itself: "1 January 2025", "January 1, 2025", "2025-01-01", "1/1/2025". */
const FULL_DATE = new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?${MONTH_NAMES}\\b|\\b${MONTH_NAMES}\\.?\\s+\\d{1,2}(st|nd|rd|th)?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b`, "i");

/**
 * A fact's date at its precision: "3 Oct 2026" (day), "Oct 2026" (month), "2026" (year); null for none. A fact with no
 * precision stored on 1 January (older merges kept a year that way) reads as the year, unless its claim states a full
 * date itself.
 */
export function factDate(iso: string | null | undefined, precision?: KnowsFact["datePrecision"], claim?: string | null): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (precision === "year") return y;
  if (precision === "month") return `${MONTHS[Number(mo) - 1]} ${y}`;
  if (!precision && mo === "01" && d === "01" && !FULL_DATE.test(claim ?? "")) return y;
  return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`;
}

/** A fact row's meta: "Found · 3 Oct 2026 · Couldn't confirm". */
export function factMeta(f: Pick<KnowsFact, "provenance" | "date" | "unconfirmed" | "confirmedByYou"> & Partial<Pick<KnowsFact, "datePrecision" | "claim">>): string {
  return [PROVENANCE_WORDS[f.provenance], factDate(f.date, f.datePrecision, f.claim), f.unconfirmed ? KNOWS_COPY.unconfirmed : f.confirmedByYou ? KNOWS_COPY.confirmedByYou : null].filter(Boolean).join(" · ");
}

export function KnowsFactsScreen() {
  const navigation = useNavigation<any>();
  const facts = useMeFacts(true);
  const act = useFactAction();
  const [open, setOpen] = useState<KnowsFact | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const v = facts.data && facts.data.status === "ready" ? facts.data : null;
  const c = KNOWS_COPY;

  const close = () => { setOpen(null); setEditing(false); setDraft(""); };
  const run = (a: Parameters<typeof act.mutate>[0], done: string, after?: () => void) =>
    act.mutate(a, { onSuccess: () => { setNote(done); close(); after?.(); }, onError: () => setNote(c.failed) });

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <StackHeader title={c.back} bold onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="knows-facts">
        <View style={styles.head}>
          <SectionHead title={c.title} />
          <Text style={styles.lede}>{c.lede}</Text>
          {v ? <Text style={styles.counts} testID="knows-counts">{c.counts(v.counts.total, v.counts.unconfirmed)}</Text> : null}
          {note ? <Text style={styles.note} accessibilityLiveRegion="polite" testID="knows-note">{note}</Text> : null}
        </View>

        {facts.isLoading ? <ActivityIndicator style={styles.spinner} color={Bold.ink} testID="knows-loading" /> : null}
        {facts.isError ? <Text style={styles.state} testID="knows-error">{c.loadError}</Text> : null}
        {facts.data?.status === "no_memory" || (v && !v.counts.total && !v.private.length) ? <Text style={styles.state} testID="knows-empty">{c.empty}</Text> : null}

        {v?.sections.filter((s) => s.facts.length).map((s) => (
          <Card bold style={styles.card} key={s.key} testID={`knows-section-${s.key}`}>
            <RuledHead title={SECTION_LABEL[s.key]} style={styles.ruled} />
            {s.facts.map((f, i) => (
              <Row bold key={f.id} value={f.claim} lines={3} meta={factMeta(f)} onPress={() => { setNote(null); setOpen(f); }} last={i === s.facts.length - 1} accessibilityLabel={`${f.claim}. ${factMeta(f)}`} />
            ))}
          </Card>
        ))}

        {v?.private.length ? (
          <Card bold style={styles.card} testID="knows-private">
            <RuledHead title={c.private} style={styles.ruled} />
            {v.private.map((f, i) => <Row bold key={f.id} value={f.claim} lines={3} meta={factMeta(f)} onPress={() => { setNote(null); setOpen(f); }} last={i === v.private.length - 1} />)}
          </Card>
        ) : null}

        {v?.hidden.length ? (
          <Card bold style={styles.card} testID="knows-hidden">
            <RuledHead title={c.hidden} style={styles.ruled} />
            {v.hidden.map((h, i) => (
              <Row bold key={h.id} value={h.claim} lines={2} last={i === v.hidden.length - 1} trailing={(
                <Pressable onPress={() => run({ kind: "restore", id: h.id }, c.rerun)} accessibilityRole="button" accessibilityLabel={`${c.restore}: ${h.claim}`} hitSlop={8} testID={`knows-restore-${h.id}`}>
                  <Text style={styles.link}>{c.restore}</Text>
                </Pressable>
              )} />
            ))}
          </Card>
        ) : null}
      </ScrollView>

      {open ? (
        <DetailSheet title={c.factTitle} onClose={close} testID="knows-fact-sheet">
          <View style={styles.sheet}>
            <Text style={styles.claim}>{open.claim}</Text>
            <View style={styles.chips}>
              <Chip bold="line">{PROVENANCE_WORDS[open.provenance]}</Chip>
              {open.unconfirmed ? <Chip bold="line">{c.unconfirmed}</Chip> : null}
            </View>
            {open.sources.length ? (
              <View style={styles.sources}>
                <Eyebrow>{c.sources}</Eyebrow>
                {open.sources.map((s) => <Text key={`${s.label}${s.url ?? ""}`} style={styles.source} numberOfLines={2}>{s.label}</Text>)}
              </View>
            ) : null}
            {editing ? (
              <View style={styles.edit}>
                <TextInput value={draft} onChangeText={setDraft} multiline style={styles.input} accessibilityLabel={c.change} autoFocus testID="knows-edit-input" />
                <View style={styles.row}>
                  <Button bold="primary" onPress={() => run({ kind: "correct", id: open.id, claim: draft.trim() }, c.rerun)} disabled={!draft.trim() || act.isPending} style={styles.flex} testID="knows-save">{c.save}</Button>
                  <Button bold="secondary" onPress={() => setEditing(false)} style={styles.flex}>{c.cancel}</Button>
                </View>
              </View>
            ) : (
              <View style={styles.actions}>
                <Button bold="primary" onPress={() => run({ kind: "confirm", id: open.id }, c.confirmed)} disabled={act.isPending} testID="knows-confirm">{c.confirm}</Button>
                {open.editable
                  ? <Button bold="secondary" onPress={() => { setDraft(open.claim); setEditing(true); }} testID="knows-change">{c.change}</Button>
                  : <Text style={styles.measured}>{c.measured}</Text>}
                <Button bold="secondary" onPress={() => { const claim = open.claim; run({ kind: "dispute", id: open.id }, c.rerun, () => openMila({ draft: c.disputeDraft(claim) })); }} disabled={act.isPending} testID="knows-dispute">{c.dispute}</Button>
                <Button bold="link" onPress={() => run({ kind: "hide", id: open.id }, c.rerun)} disabled={act.isPending} testID="knows-hide">{c.hide}</Button>
              </View>
            )}
          </View>
        </DetailSheet>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: Bold.paper },
  content:  { paddingBottom: 40 },
  head:     { paddingHorizontal: Bold.gutter, marginTop: 8, gap: 6 },
  lede:     { ...BoldType.body, color: Bold.ink2 },
  counts:   { ...BoldType.rowMeta, color: Bold.mute },
  note:     { ...BoldType.rowMeta, color: Bold.ink },
  spinner:  { marginTop: 24 },
  state:    { ...BoldType.body, color: Bold.mute, paddingHorizontal: Bold.gutter, marginTop: 16 },
  card:     { marginHorizontal: Bold.gutter, marginTop: 14 },
  ruled:    { marginHorizontal: 14, marginTop: 12 },
  link:     { ...BoldType.buttonSmall, color: Bold.blue },
  sheet:    { paddingHorizontal: Bold.gutter, paddingTop: 14, gap: 12 },
  claim:    { ...BoldType.goalSm, color: Bold.ink },
  chips:    { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  sources:  { gap: 4 },
  source:   { ...BoldType.rowMeta, color: Bold.ink2 },
  actions:  { gap: 8, marginTop: 4 },
  measured: { ...BoldType.caption, color: Bold.mute },
  edit:     { gap: 10 },
  input:    { ...BoldType.body, color: Bold.ink, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, padding: 12, minHeight: 88, textAlignVertical: "top" },
  row:      { flexDirection: "row", gap: 8 },
  flex:     { flex: 1 },
});
