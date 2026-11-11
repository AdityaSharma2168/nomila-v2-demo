// Concept 0.4 · My Story — the sections under the hero, composed from GET /me/story by lib/myStoryLogic.ts (DESIGN.md
// "My Story", look B; the density pass, Oct 2026). The structure is frozen; the content is Identity Intelligence's,
// never rewritten.
//
// Each section is ONE collapsed card (ui/Accordion): its title, a one-line summary taken from its first line, and a
// count or thumbnails. One opens at a time, in place; the screen scrolls the opening card's head under the top bar.
//
//   What defines you      thumbnails of the pillars; opens to a HORIZONTAL SWIPE of pillar cards (200 wide: her photo,
//                         or a type-led tile with the pillar's initial; the label; three lines of the definition);
//                         tapping a card shows its proof points (at most three) and one quiet ⓘ beneath the rail
//   Your story so far     the first chapter's line; opens to ONE line per chapter with its fixed label, then "Read the
//                         full story" expanding to the full chapters — served text exactly, "In your words" beneath a
//                         chapter only when one of her statements relates (the blue rule), one quiet ⓘ each
//   What you stand for    standsFor as the summary; opens to the display statement, the long form, her related statement
//   Where you're headed   her PRIMARY direction as the summary; opens to it in the black block (positioning.desired
//                         verbatim, "From you") and the other directions as rows with their domain labels
//   What Nomila sees      imageGap as the summary; opens to it exactly, one ⓘ
//
// Every string here is served text or a fixed label (lib/myStoryLogic SECTION / CHAPTER_LABEL / domainLabel). The
// strength of an object (established / reported / approved) is spoken only inside the Why sheet, never on the face.
// Her words alone take the her-words block; Nomila's text never does. No "Refine with Mila" in S1. Bold tokens only.

import React, { useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import { Row, Sheet, Eyebrow, HerWords, LinkText, IconTile, Accordion, AccordionGroup } from "../ui";
import { Bold, BoldType } from "../../constants/theme";
import type { MeStory, MeStoryStatement } from "../../lib/meStoryLogic";
import {
  SECTION, chapterModel, headedModel, pillarModel, seesModel, standsForModel, statementSourceLine, whyModel,
  type ChapterModel, type PillarModel, type StoryImagery, type WhyTarget,
} from "../../lib/myStoryLogic";
import { cachedSource } from "../../lib/imageCache";

export const STORY_COPY = { readFull: "Read the full story", swipe: (i: number, n: number) => `Swipe · ${i} of ${n}` } as const;
const PILLAR_CARD = 200;

// ── shared pieces ─────────────────────────────────────────────────────────────

/**
 * The subtle affordance that opens the basis and the strength. `iconOnly` is the quiet ⓘ (one per item); the label
 * stays for assistive tech. `onHero` on a photo or the dark ground.
 */
export function WhyButton({ onPress, onHero, compact, iconOnly }: { onPress: () => void; onHero?: boolean; compact?: boolean; iconOnly?: boolean }) {
  const ink = onHero ? Bold.onDark : Bold.mute;
  if (iconOnly) {
    return (
      <Pressable onPress={onPress} hitSlop={10} style={[styles.whyIcon, onHero && styles.whyIconOnHero]} accessibilityRole="button" accessibilityLabel={SECTION.why}>
        <Feather name="info" size={15} color={onHero ? Bold.onDark : Bold.quiet} />
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} hitSlop={8} style={[styles.why, onHero && styles.whyOnHero, compact && styles.whyCompact]} accessibilityRole="button" accessibilityLabel={SECTION.why}>
      <Feather name="info" size={16} color={ink} />
      <Text style={[styles.whyText, { color: ink }]}>{SECTION.why}</Text>
    </Pressable>
  );
}

/** One of her statements, verbatim, with where it is from — the her-words block; the style is hers alone. */
export function QuoteBlock({ statement, label = SECTION.inHerWords, style }: { statement: MeStoryStatement; label?: string; style?: object }) {
  return (
    <HerWords
      label={label}
      text={`${statement.text}${statement.truncated ? " …" : ""}`}
      source={statementSourceLine(statement)}
      url={statement.source.url}
      style={style}
      testID={`quote-${statement.id}`}
    />
  );
}

/** "Why Nomila sees this": the strength and the basis in fixed words, and the statements the object cites. */
export function WhySheet({ target, statements, onClose }: { target: WhyTarget | null; statements: MeStoryStatement[]; onClose: () => void }) {
  if (!target) return null;
  const w = whyModel(target, statements);
  return (
    <Sheet onClose={onClose} eyebrow={target.title} value={target.text}>
      <View style={styles.whyBody} testID="why-sheet">
        {w.strengthLine ? <Text style={styles.whyStrong}>{w.strengthLine}</Text> : null}
        {w.basisLine ? <Text style={styles.whyLine}>{w.basisLine}</Text> : null}
        {!w.strengthLine && !w.basisLine ? <Text style={styles.whyLine}>Nomila has not recorded a basis for this yet.</Text> : null}
        {w.quotes.map((q) => <QuoteBlock key={q.id} statement={q} label={SECTION.inHerWords} style={styles.whyQuote} />)}
      </View>
    </Sheet>
  );
}

/** The pillars' thumbnails at the head of the collapsed card: her photo, or the pillar's initial on the ground. */
function Thumbs({ pillars, photos }: { pillars: PillarModel[]; photos: Array<string | null> }) {
  return (
    <View style={styles.thumbs} testID="story-pillar-thumbs">
      {pillars.slice(0, 3).map((p, i) => photos[i]
        ? <Image key={p.key} source={cachedSource(photos[i]!)} style={[styles.thumb, i > 0 && styles.thumbOverlap]} cachePolicy="memory-disk" contentFit="cover" contentPosition="top" accessibilityIgnoresInvertColors />
        : <View key={p.key} style={[styles.thumb, styles.thumbTypeLed, i > 0 && styles.thumbOverlap]}><Text style={styles.thumbGlyph}>{p.label.slice(0, 1)}</Text></View>)}
    </View>
  );
}

// ── 2. what defines you: the swipe rail ──────────────────────────────────────

function PillarRail({ pillars, photos, onWhy }: { pillars: PillarModel[]; photos: Array<string | null>; onWhy: (p: PillarModel) => void }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { width } = useWindowDimensions();
  const open = pillars.find((p) => p.key === openKey) ?? null;
  const onEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => setPage(Math.max(0, Math.min(pillars.length - 1, Math.round(e.nativeEvent.contentOffset.x / (PILLAR_CARD + 10)))));
  return (
    <View style={styles.railWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={PILLAR_CARD + 10} decelerationRate="fast" contentContainerStyle={styles.rail} onMomentumScrollEnd={onEnd} style={{ marginHorizontal: -14, width: width - 2 }} testID="story-pillar-rail">
        {pillars.map((p, i) => (
          <Pressable key={p.key} testID={`pillar-${p.key}`} onPress={() => setOpenKey((k) => (k === p.key ? null : p.key))} accessibilityRole="button" accessibilityState={{ expanded: openKey === p.key }} accessibilityLabel={p.label} style={({ pressed }) => [styles.pillarCard, pressed && styles.pressed]}>
            {photos[i]
              ? <Image source={cachedSource(photos[i]!)} style={styles.pillarPhoto} cachePolicy="memory-disk" contentFit="cover" contentPosition="top" accessibilityIgnoresInvertColors />
              : <View style={[styles.pillarPhoto, styles.pillarTypeLed]} testID={`pillar-tile-${p.key}`}><Text style={styles.pillarGlyph}>{p.label.slice(0, 1)}</Text></View>}
            <Text style={styles.pillarLabel} numberOfLines={2}>{p.label}</Text>
            {p.definition ? <Text style={styles.pillarDefinition} numberOfLines={3}>{p.definition}</Text> : null}
          </Pressable>
        ))}
      </ScrollView>
      {pillars.length > 1 ? <Text style={styles.swipe}>{STORY_COPY.swipe(page + 1, pillars.length)}</Text> : null}
      {open ? (
        <View style={styles.pillarOpen} testID={`pillar-open-${open.key}`}>
          <Text style={styles.pillarOpenTitle}>{open.label}</Text>
          {open.proof.length ? (
            <>
              <Eyebrow>{SECTION.proof}</Eyebrow>
              {open.proof.map((pr) => (
                <View key={pr.key} style={styles.proofRow}>
                  <View style={styles.proofDot} />
                  <Text style={styles.proofText}>{pr.text}</Text>
                </View>
              ))}
            </>
          ) : null}
          <View style={styles.pillarWhy}><WhyButton onPress={() => onWhy(open)} iconOnly /></View>
        </View>
      ) : null}
    </View>
  );
}

// ── 3. your story so far ──────────────────────────────────────────────────────

function ChapterRow({ chapter, last, onWhy }: { chapter: ChapterModel; last: boolean; onWhy: () => void }) {
  return (
    <View style={[styles.chapter, last && styles.chapterLast]} testID={`chapter-${chapter.key}`}>
      <View style={styles.railCol}>
        <View style={styles.railDot} />
        {!last ? <View style={styles.railLine} /> : null}
      </View>
      <View style={styles.chapterBody}>
        <View style={styles.chapterHead}>
          <Eyebrow>{chapter.label}</Eyebrow>
          <WhyButton onPress={onWhy} iconOnly />
        </View>
        <Text style={styles.chapterText}>{chapter.text}</Text>
        {chapter.quote ? <QuoteBlock statement={chapter.quote} style={styles.chapterQuote} /> : null}
      </View>
    </View>
  );
}

/** The brief: one line per chapter under its label, then "Read the full story". */
function ChaptersBrief({ chapters, onFull }: { chapters: ChapterModel[]; onFull: () => void }) {
  return (
    <View style={styles.brief} testID="story-chapters-brief">
      {chapters.map((c) => (
        <View key={c.key} style={styles.briefRow} testID={`chapter-brief-${c.key}`}>
          <View style={styles.briefDot} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Eyebrow>{c.label}</Eyebrow>
            <Text style={styles.briefText} numberOfLines={1}>{c.text}</Text>
          </View>
        </View>
      ))}
      <LinkText onPress={onFull} testID="story-read-full">{STORY_COPY.readFull}</LinkText>
    </View>
  );
}

// ── the body ──────────────────────────────────────────────────────────────────

export function MyStoryBody({ story, imagery, onOpen }: { story: MeStory; imagery: StoryImagery; onOpen?: (id: string, y: number) => void }) {
  const [why, setWhy] = useState<WhyTarget | null>(null);
  const [full, setFull] = useState(false);
  const used = new Set<string>();
  const pillars = pillarModel(story);
  const chapters = chapterModel(story, used);
  const standsFor = standsForModel(story, used);
  const headed = headedModel(story);
  const sees = seesModel(story);
  const headedCount = (headed?.lead ? 1 : 0) + (headed?.others.length ?? 0);

  return (
    <View style={styles.body}>
      <AccordionGroup onOpen={onOpen}>
        {pillars.length ? (
          <Accordion id="pillars" title={SECTION.pillars.title} summary={pillars.map((p) => p.label).join(" · ")} count={pillars.length} lead={<Thumbs pillars={pillars} photos={imagery.pillars} />} testID="story-pillars">
            <PillarRail pillars={pillars} photos={imagery.pillars} onWhy={(p) => setWhy({ title: p.label, slot: `pillar:${p.key}`, text: p.definition || p.label, basis: p.basis, strength: p.strength })} />
          </Accordion>
        ) : null}

        {chapters.length ? (
          <Accordion id="chapters" title={SECTION.chapters.title} summary={chapters[0].text} count={chapters.length} lead={<IconTile icon="book-open" bold="grey" />} testID="story-chapters">
            {full ? (
              <View style={styles.chapters} testID="story-chapters-full">
                {chapters.map((c, i) => (
                  <ChapterRow key={c.key} chapter={c} last={i === chapters.length - 1} onWhy={() => setWhy({ title: c.label, slot: `chapters.${c.key}`, text: c.text, basis: c.basis, strength: c.strength })} />
                ))}
              </View>
            ) : <ChaptersBrief chapters={chapters} onFull={() => setFull(true)} />}
          </Accordion>
        ) : null}

        {standsFor ? (
          <Accordion id="standsFor" title={SECTION.standsFor.title} summary={standsFor.short} lead={<IconTile icon="flag" bold="grey" />} testID="story-stands-for">
            <View style={styles.standsFor}>
              <View style={styles.headRow}>
                <Text style={[styles.statement, { flex: 1 }]}>{standsFor.short}</Text>
                <WhyButton onPress={() => setWhy({ title: SECTION.standsFor.title, slot: "standsFor", text: standsFor.short, basis: standsFor.basis, strength: standsFor.strength })} iconOnly />
              </View>
              {standsFor.long ? <Text style={styles.statementLong}>{standsFor.long}</Text> : null}
              {standsFor.quote ? <QuoteBlock statement={standsFor.quote} style={styles.standsForQuote} /> : null}
            </View>
          </Accordion>
        ) : null}

        {headed ? (
          <Accordion id="headed" title={SECTION.headed.title} summary={headed.lead ? `“${headed.lead.text}”` : headed.others[0]?.text ?? null} count={headedCount} lead={<IconTile icon="compass" bold="grey" />} testID="story-headed">
            <Text style={styles.sub}>{SECTION.headed.sub}</Text>
            {headed.lead ? (
              <View style={styles.headedLead} testID="story-headed-lead">
                <Feather name="compass" size={18} color={Bold.onDark} />
                <Eyebrow onDark>{SECTION.headed.lead}</Eyebrow>
                <Text style={styles.headedLeadText}>{headed.lead.text}</Text>
              </View>
            ) : null}
            {headed.others.length ? (
              <View style={styles.headedOthers} testID="story-headed-others">
                {headed.others.map((d, i) => (
                  <Row bold key={d.objectiveId ?? `${i}`} label={d.label ?? undefined} value={d.text} lines={4} last={i === headed.others.length - 1} style={styles.headedRow} />
                ))}
              </View>
            ) : null}
          </Accordion>
        ) : null}

        {sees ? (
          <Accordion id="sees" title={SECTION.sees.title} summary={sees.text} lead={<IconTile icon="search" bold="grey" />} testID="story-sees">
            <View style={styles.headRow}>
              <Text style={[styles.seesText, { flex: 1 }]}>{sees.text}</Text>
              <WhyButton onPress={() => setWhy({ title: SECTION.sees.title, slot: "imageGap", text: sees.text, basis: sees.basis, strength: sees.strength })} iconOnly />
            </View>
            <Text style={styles.sub}>{SECTION.sees.sub}</Text>
          </Accordion>
        ) : null}
      </AccordionGroup>

      <WhySheet target={why} statements={story.athleteStatements} onClose={() => setWhy(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  body:         { paddingHorizontal: Bold.gutter, paddingTop: 12, paddingBottom: 16, gap: 10 },
  headRow:      { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  sub:          { ...BoldType.lede, color: Bold.mute },
  pressed:      { opacity: 0.85 },

  // why
  why:          { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 10, borderRadius: Bold.radius.control, borderWidth: 1, borderColor: Bold.line },
  whyOnHero:    { borderColor: "rgba(255,255,255,0.5)" },
  whyCompact:   { borderWidth: 0, paddingHorizontal: 0, paddingVertical: 4 },
  whyText:      { ...BoldType.caption },
  whyIcon:      { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  whyIconOnHero:{ borderWidth: 1, borderColor: "rgba(255,255,255,0.5)" },
  whyBody:      { paddingHorizontal: 20, paddingVertical: 16, gap: 8 },
  whyStrong:    { ...BoldType.body, color: Bold.ink },
  whyLine:      { ...BoldType.body, color: Bold.ink2 },
  whyQuote:     { marginTop: 8 },

  // thumbnails
  thumbs:       { flexDirection: "row", alignItems: "center" },
  thumb:        { width: 36, height: 36, borderRadius: Bold.radius.control, borderWidth: 2, borderColor: Bold.paper, backgroundColor: Bold.ground, overflow: "hidden" },
  thumbOverlap: { marginLeft: -12 },
  thumbTypeLed: { alignItems: "center", justifyContent: "center" },
  thumbGlyph:   { ...BoldType.sigValue, color: Bold.ink },

  // pillars: the swipe rail
  railWrap:     { gap: 10 },
  rail:         { paddingHorizontal: 14, gap: 10 },
  pillarCard:   { width: PILLAR_CARD, gap: 6 },
  pillarPhoto:  { width: PILLAR_CARD, height: 130, borderRadius: Bold.radius.card, backgroundColor: Bold.ground },
  pillarTypeLed:{ alignItems: "center", justifyContent: "center" },
  pillarGlyph:  { ...BoldType.display, color: Bold.ink },
  pillarLabel:  { ...BoldType.h4, color: Bold.ink, textTransform: "uppercase", marginTop: 4 },
  pillarDefinition:{ ...BoldType.rowMeta, color: Bold.ink2 },
  swipe:        { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
  pillarOpen:   { paddingTop: 12, gap: 8, borderTopWidth: 1, borderTopColor: Bold.line },
  pillarOpenTitle:{ ...BoldType.h4, color: Bold.ink },
  pillarWhy:    { flexDirection: "row", justifyContent: "flex-end" },
  proofRow:     { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  proofDot:     { width: 6, height: 6, borderRadius: 3, backgroundColor: Bold.ink, marginTop: 8 },
  proofText:    { flex: 1, ...BoldType.lede, color: Bold.ink2 },

  // chapters
  brief:        { gap: 10 },
  briefRow:     { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  briefDot:     { width: 10, height: 10, borderRadius: 5, backgroundColor: Bold.ink, marginTop: 4 },
  briefText:    { ...BoldType.rowMeta, color: Bold.ink2 },
  chapters:     {},
  chapter:      { flexDirection: "row", gap: 12 },
  chapterLast:  {},
  railCol:      { width: 14, alignItems: "center" },
  railDot:      { width: 12, height: 12, borderRadius: 6, backgroundColor: Bold.ink, marginTop: 5 },
  railLine:     { flex: 1, width: 2, backgroundColor: Bold.line, marginVertical: 4 },
  chapterBody:  { flex: 1, paddingBottom: 22, gap: 8 },
  chapterHead:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  chapterText:  { ...BoldType.body, color: Bold.ink2 },
  chapterQuote: { marginTop: 2 },

  // stands for
  standsFor:    { gap: 12 },
  statement:    { ...BoldType.statement, color: Bold.ink },
  statementLong:{ ...BoldType.body, color: Bold.ink2 },
  standsForQuote:{ marginTop: 2 },

  // headed — the black block
  headedLead:   { backgroundColor: Bold.ink, borderRadius: Bold.radius.card, paddingHorizontal: 16, paddingVertical: 18, gap: 8 },
  headedLeadText:{ ...BoldType.headedTitle, color: Bold.onDark },
  headedOthers: { marginTop: 4 },
  headedRow:    { paddingHorizontal: 0 },

  // sees
  seesText:     { ...BoldType.body, color: Bold.ink2 },
});
