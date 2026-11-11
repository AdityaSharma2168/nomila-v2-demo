// Concept 0.4 · My Story — MeStack › Story, reached from Me's "My Story" door (DESIGN.md "My Story", look B).
//
//   Hero        MeHero, full-bleed: her eligible photo (the shared pool, this screen's hero rank) anchored to the top,
//               under the deep scrim; ‹ HOME; "My story"; ONE strong statement (throughline.short) in display caps and
//               ONE short supporting line (essence.short) — no paragraph; one quiet ⓘ
//   Body        components/story/MyStoryBody: What defines you · Your story so far · What you stand for · Where
//               you're headed · What Nomila sees — each only when the story holds it, each a collapsed card that opens
//               in place, one at a time (the density pass): the opening card scrolls its head under the top bar
//   learning    the hero with the quiet learning line; Where you're headed still shows when she has a goal (a rules
//               part, live), nothing else
//
// Read-only: My Story composes stored text and never rewrites it. No "Refine with Mila" in S1 (S2). Imagery: her own
// photos only (storyImagery over the shared pool) — the hero takes this screen's candidate, each pillar the next
// distinct one, else a type-led tile.

import React, { useRef, useState } from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, StyleSheet, ActivityIndicator, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { useNavigation } from "@react-navigation/native";
import { MeHero } from "../../components/me/MeHero";
import { MyStoryBody, WhyButton, WhySheet } from "../../components/story/MyStoryBody";
import { useMeOverview, useMePool } from "../../hooks/use-me-knowledge";
import { useMeStory } from "../../hooks/use-me-story";
import { STORY_LEARNING_LINE } from "../../lib/meStoryLogic";
import { SECTION, heroModel, storyImagery, storyPage, type WhyTarget } from "../../lib/myStoryLogic";
import { Button } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";
import { cachedSource } from "../../lib/imageCache";

export function MyStoryScreen() {
  const navigation = useNavigation();
  const o = useMeOverview().data;
  const story = useMeStory();
  const pool = useMePool();
  const [why, setWhy] = useState<WhyTarget | null>(null);
  const scroll = useRef<ScrollView>(null);
  const bodyY = useRef(0);

  const s = story.data ?? null;
  const page = storyPage(s);
  const hero = s ? heroModel(s) : null;
  const imagery = storyImagery(pool, s?.pillars.length ?? 0);
  const photo = imagery.hero;
  void o;
  // The opening card's head goes under the top bar (52 + a breath); the card's y is relative to the body.
  const onOpen = (_id: string, y: number) => scroll.current?.scrollTo({ y: Math.max(0, bodyY.current + y - 60), animated: true });
  const onBodyLayout = (e: LayoutChangeEvent) => { bodyY.current = e.nativeEvent.layout.y; };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView ref={scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <MeHero
          photoUrl={photo}
          onBack={() => navigation.goBack()}
          loading={story.isLoading}
          eyebrow={SECTION.hero.eyebrow}
          minHeight={hero ? 360 : 340}
          deep
          // The crop is anchored to the top of the photo (a landscape post keeps its heads); MeHero's scrim does the rest.
          photo={photo ? <Image source={cachedSource(photo)} style={StyleSheet.absoluteFill} cachePolicy="memory-disk" contentFit="cover" contentPosition="top" accessibilityIgnoresInvertColors /> : null}
          subtitle={
            hero
              ? (
                <>
                  <Text style={styles.statement} testID="story-hero-statement">{hero.text}</Text>
                  {hero.support ? <Text style={styles.support} testID="story-hero-support">{hero.support}</Text> : null}
                </>
              )
              : !story.isLoading ? <Text style={styles.learning} testID="story-hero-learning">{STORY_LEARNING_LINE}</Text> : null
          }
        >
          {story.isError ? <Button bold="onHero" onPress={() => story.refetch()} style={styles.retry}>Retry</Button> : null}
          {hero ? (
            <View style={styles.whyRow}>
              <WhyButton onHero iconOnly onPress={() => setWhy({ title: SECTION.hero.eyebrow, slot: hero.slot, text: hero.text, basis: hero.form.basis ?? [], strength: hero.form.strength ?? null })} />
            </View>
          ) : null}
        </MeHero>

        {s && page !== "unavailable" ? <View onLayout={onBodyLayout}><MyStoryBody story={s} imagery={imagery} onOpen={onOpen} /></View> : story.isLoading ? <ActivityIndicator style={styles.spinner} color={Bold.ink} /> : null}
      </ScrollView>
      <WhySheet target={why} statements={s?.athleteStatements ?? []} onClose={() => setWhy(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: Bold.paper },
  content:   { paddingBottom: 40 },
  statement: { ...BoldType.displaySm, color: Bold.onDark },
  support:   { ...BoldType.heroLine, color: Bold.onDarkSoft, marginTop: 4 },
  learning:  { ...BoldType.heroLine, color: Bold.onDarkSoft, opacity: 0.85 },
  retry:     { alignSelf: "flex-start" },
  whyRow:    { flexDirection: "row", justifyContent: "flex-end", marginTop: 4 },
  spinner:   { marginTop: 20 },
});
