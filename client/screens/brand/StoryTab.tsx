// Brand › Story — My Story (S1), in the Brand tab. This tab promised "your story, written by Mila"; GET /me/story now
// holds it, so the tab shows it: the hero as a card (components/story/StoryHeroCard — the Brand header sits above, so
// no full-bleed hero here), then the same body the Me stack's My Story renders (components/story/MyStoryBody).
//
//   ready        the hero card + the body
//   learning     the quiet learning line; the body still shows Where you're headed when she has a goal
//   unavailable  the feature is off on this server: the note that was always here, and nothing invented
//
// Under the story, in every state, the raw material the record holds for it stays as before ("What it is written from"):
// those rows open the record editors, which in S1 is how she changes an input. The narrative one-liner the record
// carries shows only while there is no story, so nothing is said twice. No "Refine with Mila" in S1.

import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts, Spacing, Tint } from "../../constants/theme";
import { useAthleteRecord, type RecordEntry } from "../../hooks/use-athlete-record";
import { useMePool } from "../../hooks/use-me-knowledge";
import { useMeStory } from "../../hooks/use-me-story";
import { STORY_LEARNING_LINE } from "../../lib/meStoryLogic";
import { SECTION, heroModel, storyImagery, storyPage, type WhyTarget } from "../../lib/myStoryLogic";
import { RecordRow } from "../../components/record/RecordRow";
import { RecordSheet } from "../../components/record/RecordSheet";
import { MyStoryBody, WhySheet } from "../../components/story/MyStoryBody";
import { StoryHeroCard } from "../../components/story/StoryHeroCard";
import { Card, Chip } from "../../components/ui";

const C = Colors.light;

export function StoryTab({ onLink }: { onLink: (link: string) => void }) {
  const { data, isLoading } = useAthleteRecord();
  const story = useMeStory();
  const photos = useMePool();
  const [open, setOpen] = useState<RecordEntry | null>(null);
  const [why, setWhy] = useState<WhyTarget | null>(null);
  const group = data?.groups.find((g) => g.key === "story");
  // D6 (Phase A Step 2d): the record emits the narrative in the `story` group as `narrative` ("made · written from
  // research"); this tab used to look for a `story_arc` row under `numbers`, which no group has ever emitted.
  const narrative = group?.entries.find((e) => e.field === "narrative") ?? null;
  const material = group ? group.entries.filter((e) => e.field !== "narrative") : null;   // the one-liner is shown above, not twice

  const s = story.data ?? null;
  const page = storyPage(s);
  const hero = s ? heroModel(s) : null;
  const imagery = storyImagery(photos, s?.pillars.length ?? 0);

  return (
    <View style={styles.wrap}>
      {story.isLoading ? <ActivityIndicator size="small" color={C.primary} style={styles.spinner} /> : null}

      {page === "ready" && hero ? (
        <StoryHeroCard
          photoUrl={imagery.hero}
          statement={hero.text}
          onWhy={() => setWhy({ title: SECTION.hero.eyebrow, slot: hero.slot, text: hero.text, basis: hero.form.basis ?? [], strength: hero.form.strength ?? null })}
        />
      ) : null}

      {page === "learning" || (page === "ready" && !hero) ? (
        <Card style={styles.note}>
          <Card.Body style={styles.noteBody}>
            <Text style={styles.noteText} testID="story-tab-learning">{STORY_LEARNING_LINE}</Text>
          </Card.Body>
        </Card>
      ) : null}

      {page === "unavailable" && !story.isLoading ? (
        <Card style={styles.hero}>
          <Card.Body style={styles.heroBody}>
            <View style={styles.heroIcon} testID="story-tab-unavailable"><Feather name="feather" size={18} color={Tint.made.fg} /></View>
            <Text style={styles.heroTitle}>Your story, written by Mila</Text>
            <Text style={styles.heroText}>
              After your first conversation, Mila drafts your brand story from what you said and what she found:
              who you are in one line, what you stand for, three stories a brand could tell with you, and how you sound.
              You'll pick the lead and change anything.
            </Text>
            <Chip tint="made">Coming after onboarding</Chip>
          </Card.Body>
        </Card>
      ) : null}

      {s && page !== "unavailable" ? <MyStoryBody story={s} imagery={imagery} /> : null}

      {page !== "ready" && narrative?.value ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Today's one-liner</Text>
          <Card style={styles.card}>
            <Card.Body>
              <Text style={styles.quote}>{narrative.value}</Text>
              <Text style={styles.quoteMeta}>Mila made · from research. The full story replaces this.</Text>
            </Card.Body>
          </Card>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>What it is written from</Text>
        <Text style={styles.sectionSub}>Add or fix these and the story follows.</Text>
        {isLoading && <ActivityIndicator size="small" color={C.primary} style={{ paddingVertical: Spacing.lg }} />}
        {material && (
          <Card style={styles.card}>
            {material.map((e, i) => (
              <RecordRow key={e.field} entry={e} last={i === material.length - 1} onPress={setOpen} />
            ))}
          </Card>
        )}
      </View>

      <RecordSheet entry={open} onClose={() => setOpen(null)} onLink={onLink} />
      <WhySheet target={why} statements={s?.athleteStatements ?? []} onClose={() => setWhy(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:         { paddingBottom: Spacing.lg },
  spinner:      { paddingVertical: Spacing.md },
  note:         { marginHorizontal: Spacing.xl, marginTop: Spacing.sm },
  noteBody:     { paddingTop: Spacing.lg },
  noteText:     { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: C.textSecondary },
  hero:         { marginHorizontal: Spacing.xl, marginTop: Spacing.sm, backgroundColor: Tint.made.bg },
  heroBody:     { gap: Spacing.sm, paddingTop: Spacing.lg },
  heroIcon:     { width: 36, height: 36, borderRadius: 10, backgroundColor: C.card, alignItems: "center", justifyContent: "center" },
  heroTitle:    { fontFamily: Fonts.headingSemiBold, fontSize: 18, color: C.text },
  heroText:     { fontFamily: Fonts.body, fontSize: 13.5, color: C.textSecondary, lineHeight: 20 },
  section:      { marginTop: Spacing.xl },
  sectionTitle: { fontFamily: Fonts.headingSemiBold, fontSize: 16, color: C.text, paddingHorizontal: Spacing.xl },
  sectionSub:   { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet, paddingHorizontal: Spacing.xl, marginTop: 1, marginBottom: Spacing.sm },
  card:         { marginHorizontal: Spacing.xl, marginTop: Spacing.sm },
  quote:        { fontFamily: Fonts.headingSemiBold, fontSize: 17, color: C.text, lineHeight: 24 },
  quoteMeta:    { fontFamily: Fonts.body, fontSize: 11, color: C.textQuiet, marginTop: Spacing.sm },
});
