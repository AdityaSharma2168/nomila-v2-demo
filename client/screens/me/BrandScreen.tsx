// BrandScreen — one brand from What Nomila Knows › Brands & business, as a deck + a letter (DESIGN.md "Density: collapsed
// cards, decks and letters", look B). Registered as `KnowsBrand` in the Me and Home stacks.
//
//   The deck    the brand itself, from Nomila's brand research (knowledge/3 `brandProfile`, inbox_brands): pages per field
//               that exists, in BrandDeckHero's order — identity (logo · name · category, always) · about (the description
//               as stored, trimmed to ~2 sentences) · athletes they work with (chips) · their audience (summary + sport
//               chips). Images but no text research ⇒ identity plus image-only pages; nothing ⇒ a single hero. No fit
//               page: fit ratings come from deal analysis, not this record. ‹ WHAT NOMILA KNOWS rides over the top.
//   The letter  "<Brand> and you": the Knows entries about her and that brand — what Nomila knows (each fact with its tier,
//               its source and its date), what she told Nomila (her-words style), what it heard but has not confirmed,
//               the existing "This isn't right" control in each entry's sheet, and the contract request when an
//               intelligence request asks for this brand's contract. NO row stands in for data that isn't connected
//               (no deal status, no terms): a row does not exist until the data does.

import React, { useRef, useState } from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useMeKnowledge, type KnowledgeEntry } from "../../hooks/use-me-knowledge";
import { useIntelligenceRequests, type IntelligenceRequestItem } from "../../hooks/use-intelligence-requests";
import { brandDeckPages, brandGroups, brandLetterModel, tierWord, type BrandDeckPage, type BrandGroup } from "../../lib/knowledgeLogic";
import { readDate } from "../../lib/strategyLogic";
import { EntryInfoSheet } from "../../components/me/EntryInfoSheet";
import { ProvenanceGlyph } from "../../components/me/ProvenanceGlyph";
import { provenanceOf } from "../../lib/knowledgeLogic";
import { Chip, Button, IconTile, LogoMark, HerWords, StackHeader, LetterSheet, LetterBlock } from "../../components/ui";
import { Deck, DeckPanel, DeckIdentity, DeckChip, DECK_HEIGHT, LETTER_OVERLAP, type DeckPage } from "../../components/ui/Deck";
import { SourceLinks } from "../../components/ui/SourceLinks";
import { Bold, BoldType } from "../../constants/theme";

const AddContractSheet = React.lazy(() => import("../../components/deals/AddContractSheet").then((m) => ({ default: m.AddContractSheet })));

export const BRAND_COPY = {
  back: "What Nomila knows",
  andYou: (brand: string) => `${brand} and you`,
  meta: "What Nomila knows, and where each fact came from",
  knows: "What Nomila knows",
  told: "You told Nomila",
  heard: "Heard, not confirmed",
  contract: "Contract",
  contractTitle: (brand: string) => `Your ${brand} contract`,
  contractMeta: "Not on file · Nomila asked for it",
  add: "Add",
  about: (brand: string) => `About ${brand}`,
  athletes: "Athletes they work with",
  audience: "Their audience",
  notFound: "Couldn't find this brand.",
  nothingYet: "Nothing on record about you and this brand yet.",
} as const;

/** The open request that asks for THIS brand's contract, if any: the one existing path to add it. */
export function contractRequestFor(items: ReadonlyArray<IntelligenceRequestItem> | null | undefined, brand: string): IntelligenceRequestItem | null {
  const b = brand.trim().toLowerCase();
  if (!b) return null;
  return (items ?? []).find((r) => (r.status === "open" || r.status === "acquiring") && r.cta?.kind === "add_contract" && `${r.nomilaSays ?? ""} ${r.sheAsked ?? ""}`.toLowerCase().includes(b)) ?? null;
}

function pageOf(p: BrandDeckPage, i: number, n: number, g: BrandGroup): DeckPage {
  const label = i === 0 ? g.name : p.kind === "about" ? BRAND_COPY.about(g.name) : p.kind === "athletes" ? BRAND_COPY.athletes : p.kind === "audience" ? BRAND_COPY.audience : `${g.name} image ${i + 1}`;
  const children = p.kind === "identity"
    ? <DeckIdentity logo={<LogoMark logoUrl={g.logoUrl} domain={g.logoDomain} name={g.name} size={26} bold />} name={g.name} category={g.profile?.category ?? null} />
    : p.kind === "about"
      ? (
        <DeckPanel label={BRAND_COPY.about(g.name)} testID="deck-about">
          <Text style={styles.panelText} numberOfLines={5}>{p.text}</Text>
          <SourceLinks sources={p.sources} onDark testID="deck-about-sources" />
        </DeckPanel>
      )
      : p.kind === "athletes"
        ? <DeckPanel label={BRAND_COPY.athletes} testID="deck-athletes"><View style={styles.chipRow}>{p.items.map((a) => <DeckChip key={a}>{a}</DeckChip>)}</View></DeckPanel>
        : p.kind === "audience"
          ? (
            <DeckPanel label={BRAND_COPY.audience} testID="deck-audience">
              {p.text ? <Text style={styles.panelText} numberOfLines={4}>{p.text}</Text> : null}
              {p.chips.length ? <View style={styles.chipRow}>{p.chips.map((s) => <DeckChip key={s} blue>{s}</DeckChip>)}</View> : null}
            </DeckPanel>
          )
          : undefined;
  return { key: `${p.kind}-${i}`, image: p.image, children, accessibilityLabel: n > 1 ? `${label}, page ${i + 1} of ${n}` : label };
}

export function BrandScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const key: string = route.params?.key ?? "";
  const q = useMeKnowledge();
  const requests = useIntelligenceRequests();
  const scroll = useRef<ScrollView>(null);
  const [info, setInfo] = useState<KnowledgeEntry | null>(null);
  const [contractFor, setContractFor] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const group = q.data ? brandGroups(q.data).find((g) => g.key === key) ?? null : null;

  if (!group) {
    return (
      <SafeAreaView style={styles.safe}>
        <StackHeader title={BRAND_COPY.back} bold />
        <View style={styles.center}>
          {q.isLoading ? <ActivityIndicator color={Bold.ink} /> : <Text style={styles.muted}>{BRAND_COPY.notFound}</Text>}
        </View>
      </SafeAreaView>
    );
  }

  const pages = brandDeckPages(group.profile);
  const letter = brandLetterModel(group, q.data);
  const contract = contractRequestFor(requests.data?.items, group.name);
  const toLetter = () => scroll.current?.scrollTo({ y: DECK_HEIGHT - LETTER_OVERLAP - 52, animated: true });

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView ref={scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="brand-screen">
        <Deck
          pages={pages.map((p, i) => pageOf(p, i, pages.length, group))}
          onPagePress={toLetter}
          testID="brand-deck"
          topBar={<StackHeader title={BRAND_COPY.back} bold dark />}
        />

        <LetterSheet title={BRAND_COPY.andYou(group.name)} meta={BRAND_COPY.meta} testID="letter">
          {group.chips.length ? <View style={styles.chips}>{group.chips.map((c) => <Chip key={c} bold={c === "Partner" ? "dark" : "line"}>{c}</Chip>)}</View> : null}
          {sent ? <Text style={styles.muted} testID="brand-sent">{"Thanks — Nomila will treat that as unconfirmed until it's sorted."}</Text> : null}

          {letter.knows.length ? (
            <LetterBlock title={BRAND_COPY.knows} testID="brand-knows">
              {letter.knows.map((e, i) => <FactRow key={e.id} e={e} last={i === letter.knows.length - 1} onPress={() => setInfo(e)} />)}
            </LetterBlock>
          ) : null}

          {letter.told.length ? (
            <LetterBlock testID="brand-told">
              {letter.told.map((e) => (
                <Pressable key={e.id} onPress={() => setInfo(e)} accessibilityRole="button" accessibilityLabel={`${e.label}: ${e.value}`} testID={`entry-${e.id}`}>
                  <HerWords label={BRAND_COPY.told} text={e.value ?? ""} source={e.source?.detail ?? null} />
                </Pressable>
              ))}
            </LetterBlock>
          ) : null}

          {letter.unconfirmed.length ? (
            <LetterBlock title={BRAND_COPY.heard} testID="brand-heard">
              {letter.unconfirmed.map((e, i) => <FactRow key={e.id} e={e} last={i === letter.unconfirmed.length - 1} onPress={() => setInfo(e)} dim />)}
            </LetterBlock>
          ) : null}

          {!letter.knows.length && !letter.told.length && !letter.unconfirmed.length ? <Text style={styles.muted}>{BRAND_COPY.nothingYet}</Text> : null}

          {contract ? (
            <LetterBlock title={BRAND_COPY.contract} testID="brand-contract">
              <View style={styles.row}>
                <IconTile icon="file-text" bold="black" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowValue} numberOfLines={1}>{BRAND_COPY.contractTitle(group.name)}</Text>
                  <Text style={styles.caption} numberOfLines={2}>{contract.nomilaSays || BRAND_COPY.contractMeta}</Text>
                </View>
                <Button bold="small" onPress={() => setContractFor(contract.requestId)}>{BRAND_COPY.add}</Button>
              </View>
            </LetterBlock>
          ) : null}
        </LetterSheet>
      </ScrollView>

      <EntryInfoSheet entry={info} onClose={() => setInfo(null)} onSent={() => setSent(true)} />
      {contractFor !== null ? (
        <React.Suspense fallback={null}>
          <AddContractSheet visible onClose={() => setContractFor(null)} onCreated={() => setContractFor(null)} requestId={contractFor || undefined} />
        </React.Suspense>
      ) : null}
    </SafeAreaView>
  );
}

/** One fact about her and the brand: what it is, how firmly Nomila holds it, where from, and when. Tap → its sheet. */
function FactRow({ e, last, dim, onPress }: { e: KnowledgeEntry; last: boolean; dim?: boolean; onPress: () => void }) {
  const when = readDate(e.at);
  return (
    <Pressable style={[styles.fact, last && styles.factLast]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${e.label}: ${e.value}`} testID={`entry-${e.id}`}>
      <ProvenanceGlyph kind={provenanceOf(e).glyph} unconfirmed={provenanceOf(e).unconfirmed} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={[styles.rowValue, dim && styles.dim]} numberOfLines={3}>{e.label === "Partner" ? `Partner · ${e.value}` : e.value}</Text>
        <View style={styles.factMeta}>
          <Chip bold="line" style={styles.tier}>{tierWord(e)}</Chip>
          {e.source ? <Text style={styles.caption} numberOfLines={1}>{[e.source.label, e.source.detail].filter(Boolean).join(" · ")}</Text> : null}
        </View>
      </View>
      {when ? <Text style={styles.caption}>{when}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: Bold.paper },
  center:    { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  content:   { paddingBottom: 40 },
  panelText: { ...BoldType.lede, color: Bold.onDarkSoft },
  chipRow:   { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chips:     { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  muted:     { ...BoldType.lede, color: Bold.mute },
  row:       { flexDirection: "row", alignItems: "center", gap: 10 },
  rowValue:  { ...BoldType.rowTitle, color: Bold.ink },
  dim:       { color: Bold.mute },
  caption:   { ...BoldType.caption, color: Bold.mute },
  fact:      { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Bold.line },
  factLast:  { borderBottomWidth: 0 },
  factMeta:  { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  tier:      { paddingHorizontal: 6, paddingVertical: 3 },
});
