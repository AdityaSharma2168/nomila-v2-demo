// Concept 0.4 · "What Nomila Knows" (knowledge/3, grouped on the client — DESIGN.md "What Nomila Knows", look B; the
// density pass, Oct 2026).
//
//   Hero         MeHero: her eligible photo (the shared pool, this screen's hero rank), ‹ HOME, "What Nomila knows
//                about you" (never "verified"), the lede
//   At a glance  PLAIN (always expanded): team / school (in display caps, with its own logo mark) · sport · position, then
//                place · nationality · class; "Confirmed by you" said only under a fact she herself confirmed — in the
//                one blue
//   Career       one row per ORGANISATION (exact meta.org, normalised): its own logo mark or a neutral glyph (never the
//                site that reported her), the year range, role chips (black); tapping shows the entries behind it
//   Honours      identical title + year grouped; the strongest first; the unconfirmed under "Unconfirmed (n)" — a
//                row-level fold, independent of the section's See all; the grey award tile
//   Academics    education + academic honours, or the invite
//   Brands       PLAIN: one row per brand with its relationship chips; tapping a brand opens its deck + letter (BrandScreen)
//   Media        press, accounts, followers, audience;  Interests (her words) or the invite;  Details (profile + stats)
//
// Every section but At a glance and Brands & business is COLLAPSED: a white card with its black-ruled head and the
// count, ONE preview row, and "See all N" expanding in place ("Show less" to fold). Every mark is ui/LogoMark or
// ui/IconTile; every text style a BoldType role. Provenance is a quiet glyph at the end of every row (person = you ·
// document = official · magnifier = researched · link = your accounts · briefcase = your deals; dashed = unconfirmed);
// the tier is still said in WORDS inside the entry's sheet (components/me/EntryInfoSheet). Tapping an entry she can
// correct opens the EXISTING record editors (RecordSheet / TeamSheet / CareerSheet → PUT /me/record/:field); any other
// entry opens its info sheet with "This isn't right".

import React, { useState } from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useMeKnowledge, useMePool, type AthleteKnowledge, type CategoryKey, type KnowledgeEntry } from "../../hooks/use-me-knowledge";
import {
  brandGroups, careerGroups, confirmedByYou, entryStateText, glanceModel, honoursModel, knowsLine, orgLogoDomain, presentEntries, provenanceOf, toRecordEntry,
  type BrandGroup, type CareerGroup, type HonourItem, type Provenance,
} from "../../lib/knowledgeLogic";
import { meImagery, photoUri } from "../../lib/myStoryLogic";
import type { RecordEntry } from "../../hooks/use-athlete-record";
import { RecordSheet } from "../../components/record/RecordSheet";
import { TeamSheet, type TeamDraft } from "../../components/record/TeamSheet";
import { CareerSheet } from "../../components/record/CareerSheet";
import { LogoMark } from "../../components/ui/LogoMark";
import { MeHero, MeHeroLine } from "../../components/me/MeHero";
import { ProvenanceGlyph } from "../../components/me/ProvenanceGlyph";
import { EntryInfoSheet } from "../../components/me/EntryInfoSheet";
import { Card, Chip, Button, Sheet, IconTile, RuledHead } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";

type IconName = React.ComponentProps<typeof Feather>["name"];

const COPY = {
  eyebrow: "What Nomila knows",
  title: "What Nomila knows about you",
  lede: "The information Nomila uses to understand you — from your accounts, what you tell Nomila, and the sources it found. Tap anything to see where it came from.",
  seeAll: (n: number) => `See all ${n}`,
  showLess: "Show less",
  unconfirmed: (n: number) => `Unconfirmed (${n})`,
  unconfirmedNote: "Sources disagree, or you said it isn't right. Nomila keeps these but doesn't count them.",
  behind: (n: number) => `${n} ${n === 1 ? "entry" : "entries"} on record`,
  brandsNote: "Tap a brand for everything Nomila knows about you and that brand — and the brand itself.",
} as const;

const HERO_LOGO = 48;

function Glyph({ p, count }: { p: Provenance; count?: number }) {
  return <ProvenanceGlyph kind={p.glyph} unconfirmed={p.unconfirmed} count={count} />;
}

/** An org mark: its OWN logo when the domain is the organisation's (presentation only), else the neutral glyph. */
function OrgMark({ domain, name, icon, size = 40 }: { domain: string | null; name: string; icon: IconName; size?: number }) {
  return <LogoMark domain={domain} name={name} fallbackIcon={icon} size={size} bold />;
}

/** A plain section card (At a glance, Brands & business): the black-ruled head and whatever it holds, always shown. */
function SectionCard({ title, count, children, testID }: { title: string; count?: string | null; children: React.ReactNode; testID?: string }) {
  return (
    <Card bold style={styles.card}>
      <View testID={testID}>
        <RuledHead title={title} right={count ? <Text style={styles.hint}>{count}</Text> : null} />
      </View>
      {children}
    </Card>
  );
}

/**
 * A collapsed section (the density pass): the black-ruled head with the count, ONE preview row, and "See all N" that
 * expands in place; `after` (a row-level fold such as the unconfirmed honours) shows with the rows once there is nothing
 * left to expand. Each row is a render function given whether it is the last shown (no hairline).
 */
function FoldedSection({ title, rows, invite, after, testID }: { title: string; rows: Array<(last: boolean) => React.ReactNode>; invite?: React.ReactNode; after?: React.ReactNode; testID?: string }) {
  const [open, setOpen] = useState(false);
  const n = rows.length;
  const shown = open ? rows : rows.slice(0, 1);
  const more = n > 1;
  return (
    <Card bold style={styles.card}>
      <View testID={testID}>
        <RuledHead title={title} right={n ? <Text style={styles.hint}>{n}</Text> : null} />
      </View>
      {n ? shown.map((r, i) => <React.Fragment key={i}>{r(i === shown.length - 1 && !(open || !more) )}</React.Fragment>) : invite}
      {open || !more ? after : null}
      {more ? (
        <Pressable style={styles.seeAll} onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={`${testID ?? "section"}-see-all`}>
          <Text style={styles.seeAllText}>{open ? COPY.showLess : COPY.seeAll(n)}</Text>
          <Feather name={open ? "chevron-up" : "chevron-down"} size={14} color={Bold.blue} />
        </Pressable>
      ) : null}
    </Card>
  );
}

function Invite({ text }: { text: string }) {
  return (
    <View style={styles.invite}>
      <Feather name="message-circle" size={16} color={Bold.quiet} />
      <Text style={styles.inviteText}>{text}</Text>
    </View>
  );
}

/** A plain entry row: label, value, the provenance glyph; tap → correct or info. */
function EntryRow({ e, onPress, leading, trailing, last }: { e: KnowledgeEntry; onPress: (e: KnowledgeEntry) => void; leading?: React.ReactNode; trailing?: React.ReactNode; last?: boolean }) {
  return (
    <Pressable style={[styles.row, last && styles.last]} onPress={() => onPress(e)} accessibilityRole="button" accessibilityLabel={`${e.label}: ${e.value ?? entryStateText(e)}`} testID={`entry-${e.id}`}>
      {leading}
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{e.label}</Text>
        <Text style={[styles.rowValue, !e.value && styles.empty, (e.status === "historical" || e.yourDispute) && styles.dim]} numberOfLines={3}>{e.value ?? entryStateText(e)}</Text>
      </View>
      {trailing}
      {e.state === "present" && e.source ? <Glyph p={provenanceOf(e)} /> : null}
    </Pressable>
  );
}

export function KnowsScreen() {
  const navigation = useNavigation<any>();
  const q = useMeKnowledge();
  const k = q.data;
  const pool = useMePool();
  const [edit, setEdit] = useState<RecordEntry | null>(null);
  const [teamEdit, setTeamEdit] = useState<{ teams: TeamDraft[]; index: number | null } | null>(null);
  const [careerEdit, setCareerEdit] = useState<{ status?: string | null; since?: string | null } | null | false>(false);
  const [info, setInfo] = useState<KnowledgeEntry | null>(null);
  const [behind, setBehind] = useState<{ title: string; entries: KnowledgeEntry[] } | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const onEntry = (e: KnowledgeEntry) => {
    setBehind(null);
    const r = toRecordEntry(e);
    if (!r) { setInfo(e); return; }
    if (r.shape === "teams") { const raw = (r.raw ?? {}) as { index?: number | null; teams?: TeamDraft[] }; setTeamEdit({ teams: raw.teams ?? [], index: raw.index ?? null }); return; }
    if (r.shape === "career") { setCareerEdit((r.raw as { status?: string | null; since?: string | null } | undefined) ?? null); return; }
    setEdit(r);
  };
  /** A grouped row: one entry opens directly; several open the list behind the row. */
  const onGroup = (title: string, entries: KnowledgeEntry[]) => (entries.length === 1 ? onEntry(entries[0]) : setBehind({ title, entries }));
  /** A brand row opens the brand's deck + letter. */
  const onBrand = (b: BrandGroup) => navigation.navigate("KnowsBrand", { key: b.key });

  const heroPhoto = meImagery(pool, "knows").hero;
  const hero = photoUri(heroPhoto);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <MeHero
          photoUrl={hero}
          photoKey={heroPhoto?.asset_id}
          onBack={() => navigation.goBack()}
          loading={q.isLoading}
          minHeight={300}
          eyebrow={COPY.eyebrow}
          title={COPY.title}
          titleSize="sm"
          subtitle={<MeHeroLine>{COPY.lede}</MeHeroLine>}
        >
          {q.isError ? <Button bold="onHero" onPress={() => q.refetch()} style={styles.retry}>Retry</Button> : null}
        </MeHero>

        {!k ? (
          q.isLoading ? <ActivityIndicator style={{ marginTop: 20 }} color={Bold.ink} /> : null
        ) : (
          <KnowsBody k={k} onEntry={onEntry} onGroup={onGroup} onBrand={onBrand} sent={sent} />
        )}
      </ScrollView>

      <RecordSheet entry={edit} onClose={() => setEdit(null)} />
      {teamEdit ? <TeamSheet teams={teamEdit.teams} index={teamEdit.index} onClose={() => setTeamEdit(null)} /> : null}
      {careerEdit !== false ? <CareerSheet current={careerEdit} onClose={() => setCareerEdit(false)} /> : null}
      {behind ? (
        <Sheet onClose={() => setBehind(null)} eyebrow={COPY.behind(behind.entries.length)} value={behind.title}>
          <View style={styles.behindBody} testID="knows-behind">
            {behind.entries.map((e, i) => <EntryRow key={e.id} e={e} onPress={onEntry} last={i === behind.entries.length - 1} />)}
          </View>
        </Sheet>
      ) : null}
      <EntryInfoSheet entry={info} onClose={() => setInfo(null)} onSent={(id) => setSent(id)} />
    </SafeAreaView>
  );
}

function KnowsBody({ k, onEntry, onGroup, onBrand, sent }: { k: AthleteKnowledge; onEntry: (e: KnowledgeEntry) => void; onGroup: (title: string, entries: KnowledgeEntry[]) => void; onBrand: (b: BrandGroup) => void; sent: string | null }) {
  const g = glanceModel(k);
  const cat = (key: CategoryKey) => k.categories.find((c) => c.key === key) ?? null;
  const career = careerGroups(presentEntries(k, "athletics", "teams"));
  const honours = honoursModel(presentEntries(k, "athletics", "honours"));
  const profile = presentEntries(k, "athletics", "profile").filter((e) => !g.all.some((x) => x.id === e.id));
  const stats = presentEntries(k, "athletics", "statistics");
  const academics = cat("academics");
  const brands = brandGroups(k);
  const media = [...presentEntries(k, "media", "press"), ...presentEntries(k, "media", "social")];
  const interests = presentEntries(k, "interests", "interests");
  const business = cat("business");
  const [showUnconfirmed, setShowUnconfirmed] = useState(false);
  const teamLogo = g.team ? orgLogoDomain(g.team.meta?.org ?? g.team.value, g.team.logoDomain) : null;
  const academicRows = academics && academics.state !== "unavailable" ? academics.sections.flatMap((s) => s.entries.filter((e) => e.state === "present")) : [];
  const confirmedHonours = [...honours.top, ...honours.more];
  const details = [...profile, ...stats];

  return (
    <View>
      {sent ? <Text style={styles.thanks} testID="knows-sent">{"Thanks — Nomila will treat that as unconfirmed until it's sorted."}</Text> : null}

      {/* ── at a glance: plain, always expanded ── */}
      <SectionCard title="At a glance" count={knowsLine(k.total)} testID="knows-glance">
        {g.team ? (
          <Pressable style={styles.glanceTop} onPress={() => onEntry(g.team!)} accessibilityRole="button" testID={`entry-${g.team.id}`}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.glanceTitle, !g.team.value && styles.empty]} numberOfLines={2}>{g.team.value ?? "Your team or school"}</Text>
              {g.sportLine ? <Text style={styles.glanceSub}>{g.sportLine}</Text> : null}
              {confirmedByYou(g.team) ? <Text style={styles.confirmed}>Confirmed by you</Text> : null}
            </View>
            {g.team.value ? <OrgMark domain={teamLogo} name={g.team.meta?.org ?? g.team.value} icon={g.team.meta?.orgKind === "school" ? "book-open" : "shield"} size={HERO_LOGO} /> : null}
          </Pressable>
        ) : null}
        <View style={styles.glanceRow}>
          {([[g.place, "map-pin", "Hometown"], [g.nationality, "flag", "Nationality"], [g.classYear, "book-open", "Class"]] as const).map(([e, icon, fallback]) => e ? (
            <Pressable key={e.id} style={styles.glanceCell} onPress={() => onEntry(e)} accessibilityRole="button" accessibilityLabel={`${e.label}: ${e.value ?? entryStateText(e)}`} testID={`entry-${e.id}`}>
              <Feather name={icon} size={15} color={Bold.ink} />
              <Text style={[styles.glanceCellText, !e.value && styles.empty]} numberOfLines={2}>{e.value ?? fallback}</Text>
            </Pressable>
          ) : null)}
        </View>
      </SectionCard>

      {/* ── athletic career: one row per organisation ── */}
      <FoldedSection
        title="Your athletic career" testID="knows-career"
        invite={<Invite text="No teams on record yet. Add yours and Nomila will use them everywhere." />}
        rows={career.map((grp: CareerGroup) => (last) => (
          <Pressable key={grp.key} style={[styles.row, last && styles.last]} onPress={() => onGroup(grp.org, grp.entries)} accessibilityRole="button" accessibilityLabel={`${grp.org}${grp.range ? `, ${grp.range}` : ""}`} testID={`career-${grp.key.replace(/\s+/g, "-")}`}>
            <OrgMark domain={grp.logoDomain} name={grp.org} icon={grp.orgKind === "national" ? "flag" : grp.orgKind === "school" ? "book-open" : "shield"} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowValue, grp.entries.every((e) => e.status === "historical") && styles.dim]} numberOfLines={2}>{grp.org}</Text>
              {grp.range ? <Text style={styles.rowMeta}>{grp.range}</Text> : null}
            </View>
            {grp.roles.length ? <View style={styles.chips}>{grp.roles.map((r) => <Chip key={r} bold="dark">{r}</Chip>)}</View> : null}
            <Glyph p={grp.provenance} count={grp.entries.length} />
          </Pressable>
        ))}
      />

      {/* ── recognition & honours: the strongest first; the unconfirmed apart (a row-level fold) ── */}
      <FoldedSection
        title="Recognition & honours" testID="knows-honours"
        invite={honours.unconfirmed.length ? null : <Invite text="No honours on record yet." />}
        rows={confirmedHonours.map((h) => (last) => <HonourRow key={h.key} h={h} last={last && !honours.unconfirmed.length} onPress={() => onGroup(h.name, h.entries)} />)}
        after={honours.unconfirmed.length ? (
          <>
            <Pressable style={styles.fold} onPress={() => setShowUnconfirmed((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: showUnconfirmed }} testID="knows-unconfirmed">
              <Feather name={showUnconfirmed ? "chevron-down" : "chevron-right"} size={15} color={Bold.mute} />
              <Text style={styles.foldText}>{COPY.unconfirmed(honours.unconfirmed.length)}</Text>
            </Pressable>
            {showUnconfirmed ? (
              <View testID="knows-unconfirmed-list">
                <Text style={styles.foldNote}>{COPY.unconfirmedNote}</Text>
                {honours.unconfirmed.map((h, i) => <HonourRow key={h.key} h={h} dim last={i === honours.unconfirmed.length - 1} onPress={() => onGroup(h.name, h.entries)} />)}
              </View>
            ) : null}
          </>
        ) : null}
      />

      {/* ── academics ── */}
      <FoldedSection
        title="Academics" testID="knows-academics"
        invite={<Invite text={`${academics?.blurb ?? "Nothing on record about your studies yet."} Tell Mila about your studies to add them.`} />}
        rows={academicRows.map((e) => (last) => (
          <EntryRow key={e.id} e={e} onPress={onEntry} last={last} leading={<OrgMark domain={orgLogoDomain(e.meta?.org, e.logoDomain)} name={e.meta?.org ?? e.value ?? e.label} icon={e.id.startsWith("education_") ? "book-open" : "award"} />}
            trailing={e.meta?.year && !e.id.startsWith("education_") ? <Text style={styles.year}>{e.meta.year}</Text> : null} />
        ))}
      />

      {/* ── brands & business: plain — one row per brand; a brand opens its deck + letter ── */}
      <SectionCard title="Brands & business" count={brands.length ? String(brands.length) : null} testID="knows-brands">
        {brands.map((b: BrandGroup, i) => (
          <Pressable key={b.key} style={[styles.row, i === brands.length - 1 && styles.last]} onPress={() => onBrand(b)} accessibilityRole="button" accessibilityLabel={`${b.name}: ${b.chips.join(", ")}`} testID={`brand-${b.key.replace(/\s+/g, "-")}`}>
            <LogoMark logoUrl={b.logoUrl} domain={b.logoDomain} name={b.name} size={40} bold />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowValue} numberOfLines={1}>{b.name}</Text>
              <View style={styles.chips}>{b.chips.map((c) => <Chip key={c} bold={c === "Partner" ? "dark" : "line"}>{c}</Chip>)}</View>
            </View>
            <Feather name="chevron-right" size={18} color={Bold.quiet} />
          </Pressable>
        ))}
        {!brands.length ? <Invite text="No brands on record yet." /> : null}
        {business?.state === "unavailable" ? <Invite text="Help Nomila know you: tell Mila about anything you've started or built." /> : null}
      </SectionCard>

      {/* ── media & audience ── */}
      <FoldedSection
        title="Media & audience" testID="knows-media"
        invite={<Invite text="Connect an account so Nomila can see who follows you." />}
        rows={media.map((e) => (last) => <EntryRow key={e.id} e={e} onPress={onEntry} last={last} trailing={e.evidence.length ? <Feather name="external-link" size={14} color={Bold.quiet} /> : null} />)}
      />

      {/* ── interests ── */}
      <FoldedSection
        title="Interests" testID="knows-interests"
        invite={<Invite text="Help Nomila know you: what do you care about off the field?" />}
        rows={interests.map((e) => (last) => <EntryRow key={e.id} e={e} onPress={onEntry} last={last} />)}
      />

      {/* ── details: the rest of her profile ── */}
      {details.length ? (
        <FoldedSection title="Details" testID="knows-details" rows={details.map((e) => (last) => <EntryRow key={e.id} e={e} onPress={onEntry} last={last} />)} />
      ) : null}

      <View style={styles.footer}>
        <Feather name="info" size={15} color={Bold.quiet} />
        <Text style={styles.footerText}>
          Each entry says where it came from — you, your deals, your inbox, your accounts, an official source or research — and how firmly Nomila holds it. If something isn&apos;t right, tap it. {COPY.brandsNote}
          {k.omitted.legacyValues > 0 ? " Earlier research that can't be traced to a source isn't shown here." : ""}
        </Text>
      </View>
    </View>
  );
}

function HonourRow({ h, dim, last, onPress }: { h: HonourItem; dim?: boolean; last?: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.row, last && styles.last]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${h.name}${h.year ? `, ${h.year}` : ""}`} testID={`honour-${h.entries[0].id}`}>
      <IconTile icon="award" bold="grey" muted={dim} />
      <Text style={[styles.rowValue, { flex: 1 }, dim && styles.dim]} numberOfLines={2}>{h.name}</Text>
      {h.year ? <Text style={styles.year}>{h.year}</Text> : null}
      <Glyph p={h.provenance} count={h.entries.length} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: Bold.paper },
  content:       { paddingBottom: 40 },
  retry:         { alignSelf: "flex-start" },
  card:          { marginHorizontal: Bold.gutter, marginTop: 12, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  hint:          { ...BoldType.caption, color: Bold.mute },
  glanceTop:     { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  glanceTitle:   { ...BoldType.glanceTitle, color: Bold.ink },
  glanceSub:     { ...BoldType.rowMeta, color: Bold.mute },
  confirmed:     { ...BoldType.caption, fontWeight: "700", fontFamily: BoldType.rowTitle.fontFamily, color: Bold.blue, marginTop: 2 },
  glanceRow:     { flexDirection: "row", gap: 8, paddingTop: 12, paddingBottom: 8 },
  glanceCell:    { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 6 },
  glanceCellText:{ flex: 1, ...BoldType.caption, color: Bold.ink },
  row:           { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Bold.line },
  last:          { borderBottomWidth: 0 },
  chips:         { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  year:          { ...BoldType.caption, color: Bold.mute },
  seeAll:        { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 12, paddingBottom: 8, minHeight: 44 },
  seeAllText:    { ...BoldType.link, color: Bold.blue },
  fold:          { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 12, paddingBottom: 8 },
  foldText:      { flex: 1, ...BoldType.rowMeta, color: Bold.mute },
  foldNote:      { ...BoldType.caption, color: Bold.quiet, paddingBottom: 8 },
  rowLabel:      { ...BoldType.caption, color: Bold.mute },
  rowValue:      { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:       { ...BoldType.rowMeta, color: Bold.mute, marginTop: 1 },
  empty:         { ...BoldType.body, color: Bold.quiet },
  dim:           { color: Bold.mute },
  invite:        { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 8 },
  inviteText:    { flex: 1, ...BoldType.lede, color: Bold.mute },
  thanks:        { marginHorizontal: Bold.gutter, marginTop: 12, ...BoldType.lede, color: Bold.mute },
  footer:        { flexDirection: "row", gap: 8, alignItems: "flex-start", marginHorizontal: Bold.gutter, marginTop: 12, padding: 12, backgroundColor: Bold.ground, borderRadius: Bold.radius.control },
  footerText:    { flex: 1, ...BoldType.caption, color: Bold.mute },
  behindBody:    { paddingHorizontal: 4, paddingBottom: 12 },
});
