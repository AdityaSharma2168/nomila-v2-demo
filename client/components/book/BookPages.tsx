// The brand book's page templates — one screen each, laid out by shared/bookLayout (which chapter becomes which screens,
// which ground, which of the card type's layouts). Drawn in the app's ONE LOOK (owner, 23 Oct 2026; approved comparison
// https://claude.ai/artifact/2b1Wp7qqeNEeCxLL9Dznqa, version B — it replaced the Luxe document look): white pages,
// Outfit only (names and titles in 900 capitals, the copywriter's long lines in sentence case), the one raspberry for
// the one action or highlight, 16 corners on text cards, square photos, ring colours only on the score. What made Luxe
// feel premium is kept — the full-bleed hero pages, one idea per screen, the face-aware crop, the big name — and the
// cover, the photo pages and the score card sit on the dark ground (the M.I.A. card's). The Nomila mark is on every
// page (mark.tsx). Every word is the copywriter's line or her own fact; every photo is the engine's (cropped to the
// slot around her face and graded server-side, "campaign"). Nothing scrolls inside a page.
import React from "react";
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator, type TextStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { haptics } from "../../lib/haptics";
import {
  BRAND_BOOK_COPY as C, beatRows, channelRows, dimensionRows, guardrailSource, lineOf, pillarRows, platformName, planRows,
  postStats, rateRow, sayLines, type DimensionBand,
} from "../../lib/brandBookLogic";
import { ringBands } from "../../lib/myIntelligenceLogic";
import { horizonLabel } from "../../lib/agent/goalsLogic";
import { useAgentGoalsPlan, useGoalWrite } from "../../lib/agent/hooks";
import { Bold, BoldType, outfitFamily } from "../../constants/theme";
import { fitSize, pageTone, type ReaderPage } from "../../../shared/bookLayout";
import { chipsOf, type BookPage } from "../../../shared/brandBook";
import { IntelligenceRing, RingLegend } from "../intelligence/IntelligenceRing";
import { GrowBar, KenBurns, Reveal, useArrival, useCountUp } from "./motion";
import { BookCardmark, BookFooter, RingsWatermark } from "./mark";

export interface PageProps {
  rp: ReaderPage;
  page: BookPage;
  firstName: string;
  active: boolean;
  reduce: boolean;
  /** The screen's box: type scales with its height so every page fits one screen. */
  w: number;
  h: number;
  /** Space the reader's chrome takes at the top (progress + header) and bottom (Edit pill). */
  top: number;
  bottom: number;
  /** Where the page's Nomila footer sits (bottom offset, lined up with the reader's bottom row). */
  foot?: number;
  /** The first or last screen (the reel button takes the bottom row's left: the footer steps up above it). */
  end?: boolean;
  total: number;
  onLine: (slot: string) => void;
  go: (route: string, params?: object) => void;
  /** Share the page on screen (the closing page's "Share a page"). */
  onShare?: () => void;
}

/** The dark ground: the cover, the photo pages and the score card (the M.I.A. card's black block). */
const DARK = Bold.ink;
const W900 = outfitFamily("900");
const W800 = outfitFamily("800");
const W700 = outfitFamily("700");
const W600 = outfitFamily("600");
const W500 = outfitFamily("500");

const ink = (dark: boolean) => (dark ? Bold.onDark : Bold.ink);
const ink2 = (dark: boolean) => (dark ? Bold.onDarkSoft : Bold.ink2);
/** Small labels: ≥4.5:1 on their ground (mute 5.3:1 on white; white 70% on the dark ground and the photo's foot scrim). */
const mute = (dark: boolean) => (dark ? Bold.onDarkLabel : Bold.mute);
const hair = (dark: boolean) => (dark ? Bold.lineOnDark : Bold.line);

/** A crafted line: tap to see the other versions or ask Mila. */
function Line({ text, slot, onLine, style, lines }: { text: string | null; slot: string; onLine: (s: string) => void; style: TextStyle | TextStyle[]; lines?: number }) {
  if (!text) return null;
  return (
    <Pressable onPress={() => { haptics.tap(); onLine(slot); }} accessibilityRole="button" accessibilityHint="Other versions of this line" hitSlop={4}>
      <Text style={style} numberOfLines={lines}>{text}</Text>
    </Pressable>
  );
}

/** A white page's title: the chapter's label in 900 capitals (short by construction; steps down if it runs long). */
function Title({ children, z }: { children: string; z: number }) {
  const size = fitSize(children, 32 * z, 16);
  return <Text style={[s.title, { fontSize: size, lineHeight: size * 0.98 }]} numberOfLines={3} accessibilityRole="header">{children}</Text>;
}
/** A photo page's label: a white pill over the photo (the app's photo-hero chip). */
const PhotoChip = ({ children }: { children: string }) => (
  <View style={s.photoChipWrap}><Text style={s.photoChip} numberOfLines={1}>{children}</Text></View>
);
const Rule = ({ dark }: { dark: boolean }) => <View style={[s.rule, { backgroundColor: hair(dark) }]} />;
const Label = ({ children, dark }: { children: string; dark: boolean }) => <Text style={[s.label, { color: mute(dark) }]}>{children}</Text>;

/** The photo behind a full-bleed page, with the black scrim that keeps white type legible over it. */
function Bleed({ uri, active, reduce, deep, from = 0.35 }: { uri: string; active: boolean; reduce: boolean; deep?: boolean; from?: number }) {
  return (
    <>
      <KenBurns uri={uri} active={active} reduce={reduce} style={StyleSheet.absoluteFill as object} />
      {/* A decent match reads as intended, not as a weak photo: a neutral wash (it was a gold tone in Luxe). */}
      {deep ? <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.32)" }]} /> : null}
      <LinearGradient colors={[Bold.scrimTop, Bold.scrimClear, Bold.scrimMid, Bold.scrimDeep]} locations={[0, 0.24, from, 0.84]} style={StyleSheet.absoluteFill} />
    </>
  );
}

/** A photo band across a page's top (square, full-bleed), with the top scrim the reader's white chrome reads on. */
function Band({ uri, h, active, reduce, children }: { uri: string; h: number; active: boolean; reduce: boolean; children?: React.ReactNode }) {
  return (
    <View style={{ height: h, overflow: "hidden", backgroundColor: Bold.heroBlank }}>
      <KenBurns uri={uri} active={active} reduce={reduce} style={StyleSheet.absoluteFill as object} />
      <LinearGradient colors={[Bold.scrimTop, Bold.scrimClear, Bold.scrimMid, children ? Bold.scrimFoot : Bold.scrimClear]} locations={[0, 0.34, 0.55, 1]} style={StyleSheet.absoluteFill} />
      {children}
    </View>
  );
}

export function BookScreen(p: PageProps) {
  const tone = pageTone(p.rp);
  const footer = p.rp.kind !== "cover" && p.foot != null;
  return (
    <View style={[s.screen, { width: p.w, height: p.h, backgroundColor: tone.dark ? DARK : Bold.paper }]} testID={`book-page-${p.rp.key}`}>
      {!tone.dark ? <RingsWatermark w={p.w} /> : null}
      <Template {...p} dark={tone.dark} />
      {footer ? <BookFooter label={C.markFoot.toUpperCase()} dark={tone.bottom === "dark"} bottom={(p.foot ?? 0) + (p.end ? 56 : 13)} /> : null}
    </View>
  );
}

function Template(p: PageProps & { dark: boolean }) {
  switch (p.rp.kind) {
    case "cover": return <Cover {...p} />;
    case "data": return p.rp.chapter === "listening" ? <Listening {...p} /> : <Found {...p} />;
    case "statement": return <Statement {...p} />;
    case "pillar": return <Pillar {...p} />;
    case "timeline": return <Story {...p} />;
    case "gallery": return <VoiceLook {...p} />;
    case "list":
      if (p.rp.role === "read") return <FoundRead {...p} />;
      if (p.rp.chapter === "avoid") return <Avoid {...p} />;
      return p.rp.key === "commercial.partners" ? <Partners {...p} /> : <Rates {...p} />;
    case "plan": return <Plan {...p} />;
    case "close": return <Close {...p} />;
  }
}

/** The type scale for a screen: every size steps with its height (a small phone still fits one screen). */
const k = (h: number) => Math.max(0.82, Math.min(1.08, h / 844));
const eyebrowOf = (p: PageProps) => lineOf(p.page, "eyebrow") ?? p.page.title;

// ── Cover (always on the dark ground) ────────────────────────────────────────────────────────────────────────────────
function Cover(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const coverLine = lineOf(p.page, "line");
  const name = p.firstName;
  const meta = `Tap to begin · ${p.total} pages`;
  const lineSize = fitSize(coverLine, 22 * z, 70);
  const foot = (nameSize: number) => (
    <>
      <Reveal arrival={a} order={0}><BookCardmark label={C.markCover.toUpperCase()} dark /></Reveal>
      <Reveal arrival={a} order={1}>
        <Text style={[s.coverName, { fontSize: nameSize, lineHeight: nameSize * 0.9 }]} numberOfLines={1} adjustsFontSizeToFit>{name.toUpperCase()}</Text>
      </Reveal>
      <Reveal arrival={a} order={2}><Line text={coverLine} slot="line" onLine={p.onLine} style={[s.coverLine, { fontSize: lineSize, lineHeight: lineSize * 1.22 }]} lines={6} /></Reveal>
      <Reveal arrival={a} order={3}><Text style={s.meta}>{meta}</Text></Reveal>
    </>
  );
  if (p.rp.variant === "C") {
    // Split (a decent match, or none): the photo takes the top, the name and line sit on the dark ground.
    return (
      <View style={{ flex: 1 }}>
        {p.rp.image ? <Band uri={p.rp.image} h={p.h * 0.52} active={p.active} reduce={p.reduce} /> : <View style={{ height: p.top + 40 * z }} />}
        <View style={[s.pad, { flex: 1, justifyContent: "flex-end", paddingBottom: p.bottom + 12 }]}>{foot(64 * z)}</View>
      </View>
    );
  }
  // A: full-bleed portrait, the name at the foot · B: a short line carries the giant name (the app's Home hero).
  const giant = p.rp.variant === "B";
  return (
    <View style={{ flex: 1 }}>
      {p.rp.image ? <Bleed uri={p.rp.image} active={p.active} reduce={p.reduce} from={giant ? 0.48 : 0.52} /> : null}
      <View style={[s.pad, { flex: 1, justifyContent: "flex-end", paddingBottom: p.bottom + 12 }]}>{foot(giant ? p.w * 0.21 : 64 * z)}</View>
    </View>
  );
}

// ── What we found (data A/B): the score on the dark score card, the eight dimensions as bars ─────────────────────────
const BAR: Record<DimensionBand, string> = { strong: Bold.ink, mid: Bold.ink, thin: Bold.act, none: Bold.track };
function Found(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const f = p.page.extra?.found;
  const score = useCountUp(f?.score ?? 0, p.active, p.reduce);
  const rows = dimensionRows(f?.dimensions ?? []);
  // The ring's bands are the stored contributions (books written before 23 Oct 2026 have none: one white arc).
  const bands = ringBands({ dimensions: (f?.dimensions ?? []) as never });
  const ring = p.rp.variant === "B";
  const line = lineOf(p.page, "line");
  const lineSize = fitSize(line, 20 * z, 90);
  return (
    <View style={[s.pad, { flex: 1, paddingTop: p.top + 12 * z, paddingBottom: p.bottom }]}>
      <Reveal arrival={a} order={0}><Title z={z}>{eyebrowOf(p)}</Title></Reveal>
      {f?.score != null ? (
        <Reveal arrival={a} order={1} style={s.scoreCard} >
          <IntelligenceRing score={score} bands={bands} dark glow size={Math.round((ring ? 128 : 104) * z)} outOf={C.scoreOf} />
          <View style={{ flex: 1, gap: 8 }}>
            <Text style={[s.label, { color: Bold.onDarkLabel, marginVertical: 0 }]}>{C.yourScore}</Text>
            {bands.length ? <RingLegend dark style={s.legend} /> : null}
          </View>
        </Reveal>
      ) : null}
      <Reveal arrival={a} order={2}><Line text={line} slot="line" onLine={p.onLine} style={[s.line, { color: Bold.ink, fontSize: lineSize, lineHeight: lineSize * 1.25, marginTop: 14 * z }]} lines={5} /></Reveal>
      <View style={{ marginTop: 6 * z }}>
        {rows.map((r, i) => (
          <View key={r.key} style={[s.barRow, { height: 26 * z }]} accessibilityLabel={`${r.name} ${r.score ?? "not scored"}`}>
            <Text style={[s.barName, { color: Bold.ink2 }]} numberOfLines={1}>{r.name}</Text>
            <View style={s.barTrack}>
              <GrowBar pct={r.score ?? 0} color={BAR[r.band]} active={p.active} reduce={p.reduce} delay={200 + i * 60} style={s.barFill} />
            </View>
            <Text style={[s.barScore, { color: r.band === "thin" ? Bold.act : Bold.ink }]}>{r.score ?? "—"}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The read that follows the chart: where she's strong, where it's thin, the opportunity (her read of record, as written). */
function FoundRead(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const f = p.page.extra?.found;
  const block = (label: string, items: string[], order: number, max: number) => items.length ? (
    <Reveal arrival={a} order={order} style={{ marginBottom: 12 * z }}>
      <Label dark={false}>{label}</Label>
      {items.slice(0, max).map((x, i) => <Text key={i} style={[s.body, { color: Bold.ink2, fontSize: 15 * z, lineHeight: 21.5 * z, marginBottom: 7 }]} numberOfLines={4}>{x}</Text>)}
    </Reveal>
  ) : null;
  return (
    <View style={[s.pad, { flex: 1, paddingTop: p.top + 12 * z, paddingBottom: p.bottom }]}>
      <Reveal arrival={a} order={0}><Title z={z}>{eyebrowOf(p)}</Title></Reveal>
      {block(C.strong, f?.strengths ?? [], 1, 3)}
      {block(C.thin, f?.thin ?? [], 2, 2)}
      {f?.opportunity ? (
        <Reveal arrival={a} order={3} style={[s.softCard, { padding: 14 * z }]}>
          <Label dark={false}>{C.opportunity}</Label>
          <Text style={[s.line, { color: Bold.ink, fontSize: fitSize(f.opportunity, 18 * z, 150), lineHeight: fitSize(f.opportunity, 18 * z, 150) * 1.32 }]} numberOfLines={8}>{f.opportunity}</Text>
        </Reveal>
      ) : null}
    </View>
  );
}

// ── The big idea (statement A type on white · B over the full-bleed photo · C a photo band above the line) ────────────
function Statement(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const idea = p.page.extra?.idea;
  const v = p.rp.variant;
  const dark = p.dark;
  const fromTo = idea?.from && idea?.to ? (
    <Reveal arrival={a} order={3}>
      <Rule dark={dark} />
      <Label dark={dark}>{C.from}</Label>
      <Text style={[s.body, { color: ink2(dark), fontSize: 14 * z, lineHeight: 20 * z }]} numberOfLines={3}>{idea.from}</Text>
      <Label dark={dark}>{C.to}</Label>
      <Text style={[s.line, { color: ink(dark), fontSize: 17 * z, lineHeight: 22 * z }]} numberOfLines={3}>{idea.to}</Text>
    </Reveal>
  ) : null;
  const stmt = lineOf(p.page, "line");
  const size = fitSize(stmt, 30 * z, 60);
  const big = <Line text={stmt} slot="line" onLine={p.onLine} style={[s.statement, { color: ink(dark), fontSize: size, lineHeight: size * 1.14 }]} lines={7} />;
  if (v === "B" && p.rp.image) {
    return (
      <View style={{ flex: 1 }}>
        <Bleed uri={p.rp.image} active={p.active} reduce={p.reduce} from={0.3} />
        <View style={[s.pad, { flex: 1, justifyContent: "flex-end", paddingBottom: p.bottom + 8 }]}>
          <Reveal arrival={a} order={1}><PhotoChip>{eyebrowOf(p)}</PhotoChip></Reveal>
          <Reveal arrival={a} order={2}>{big}</Reveal>
          {fromTo}
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      {v === "C" && p.rp.image
        ? <Band uri={p.rp.image} h={p.h * 0.38} active={p.active} reduce={p.reduce} />
        : <View style={{ height: p.top + 12 * z }} />}
      <View style={[s.pad, { flex: 1, justifyContent: v === "A" ? "center" : "flex-start", paddingBottom: p.bottom, paddingTop: 14 }]}>
        <Reveal arrival={a} order={1}><Title z={z}>{eyebrowOf(p)}</Title></Reveal>
        <Reveal arrival={a} order={2}>{big}</Reveal>
        {v === "A" && idea?.statement ? <Reveal arrival={a} order={3}><Text style={[s.body, { color: Bold.ink2, fontSize: 15 * z, lineHeight: 22 * z, marginTop: 4 }]} numberOfLines={5}>{idea.statement}</Text></Reveal> : null}
        {fromTo}
      </View>
    </View>
  );
}

// ── A pillar (A full-bleed · B full-bleed, deeper wash · C type on white) ───────────────────────────────────────────
function Pillar(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const row = pillarRows(p.page)[p.rp.pillar ?? 0];
  if (!row) return null;
  const num = String(row.i + 1).padStart(2, "0");
  // Short proof tags, each backed by her stored facts (server chipBacked); without them, the evidence sentence.
  const chips = chipsOf(p.page, row.i);
  const label = `${eyebrowOf(p)} · ${num}`;
  const onPhoto = !!p.rp.image && p.rp.variant !== "C";
  const dark = onPhoto;
  const nameSize = fitSize(row.name, 38 * z, 22);
  const proofSize = fitSize(row.proof, 18 * z, 95);
  const body = (
    <>
      <Reveal arrival={a} order={1}>{onPhoto ? <PhotoChip>{label}</PhotoChip> : <Label dark={false}>{label}</Label>}</Reveal>
      {!onPhoto ? <Reveal arrival={a} order={1}><Text style={[s.numeral, { fontSize: 88 * z, lineHeight: 84 * z }]}>{num}</Text></Reveal> : null}
      <Reveal arrival={a} order={2}><Line text={row.name} slot={`pillar.${row.i}.name`} onLine={p.onLine} style={[s.pillarName, { color: ink(dark), fontSize: nameSize, lineHeight: nameSize * 0.98 }]} lines={3} /></Reveal>
      <Reveal arrival={a} order={3}><Line text={row.proof} slot={`pillar.${row.i}.proof`} onLine={p.onLine} style={[s.line, { color: ink2(dark), fontSize: proofSize, lineHeight: proofSize * 1.32, marginTop: 10 * z }]} lines={6} /></Reveal>
      {chips.length ? (
        <Reveal arrival={a} order={4}>
          <Pressable onPress={() => { haptics.tap(); p.onLine(`pillar.${row.i}.chips`); }} accessibilityRole="button" accessibilityHint="Other versions of these tags" style={[s.chips, { marginTop: 14 * z }]}>
            {chips.map((c) => <Text key={c} style={[s.chip, dark ? s.chipOnDark : null]}>{c}</Text>)}
          </Pressable>
        </Reveal>
      ) : row.evidence ? <Reveal arrival={a} order={4}><Text style={[s.fact, { color: mute(dark), fontSize: 12.5 * z, lineHeight: 18 * z, marginTop: 12 * z }]} numberOfLines={3}>{row.evidence}</Text></Reveal> : null}
    </>
  );
  if (!onPhoto) {
    return <View style={[s.pad, { flex: 1, justifyContent: "center", paddingTop: p.top, paddingBottom: p.bottom }]}>{body}</View>;
  }
  return (
    <View style={{ flex: 1 }}>
      <Bleed uri={p.rp.image!} active={p.active} reduce={p.reduce} deep={p.rp.variant === "B"} from={0.42} />
      <View style={[s.pad, { flex: 1, justifyContent: "flex-end", paddingBottom: p.bottom + 8 }]}>{body}</View>
    </View>
  );
}

// ── Your story (timeline) ────────────────────────────────────────────────────────────────────────────────────────────
function Story(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const rows = beatRows(p.page).slice(p.rp.rows[0], p.rp.rows[1]);
  const last = p.rp.part.i === p.rp.part.n - 1;
  const closing = lineOf(p.page, "line");
  return (
    <View style={[s.pad, { flex: 1, paddingTop: p.top + 10 * z, paddingBottom: p.bottom }]}>
      <Reveal arrival={a} order={0}><Title z={z}>{eyebrowOf(p)}</Title></Reveal>
      {p.rp.image ? (
        <Reveal arrival={a} order={0} style={[s.inset, { height: p.h * 0.26 }]}>
          <KenBurns uri={p.rp.image} active={p.active} reduce={p.reduce} style={StyleSheet.absoluteFill as object} />
        </Reveal>
      ) : null}
      {rows.map((r, i) => (
        <Reveal key={r.i} arrival={a} order={2 + i} style={[s.beat, { paddingVertical: 9 * z }]}>
          <Text style={[s.beatDate, { fontSize: 20 * z, lineHeight: 22 * z }]}>{r.date.slice(0, 4)}</Text>
          <View style={{ flex: 1 }}>
            <Line text={r.line} slot={`beat.${r.i}`} onLine={p.onLine} style={[s.beatLine, { fontSize: 15 * z, lineHeight: 20.5 * z }]} lines={3} />
            <Text style={[s.fact, { color: Bold.mute, fontSize: 12 * z, lineHeight: 16 * z }]} numberOfLines={2}>{r.fact}</Text>
          </View>
        </Reveal>
      ))}
      {last ? <Reveal arrival={a} order={7}><Line text={closing} slot="line" onLine={p.onLine} style={[s.line, { color: Bold.ink, fontSize: fitSize(closing, 18 * z, 90), lineHeight: fitSize(closing, 18 * z, 90) * 1.32, marginTop: 12 * z }]} lines={5} /></Reveal> : null}
    </View>
  );
}

// ── Who's listening (stat tiles) ─────────────────────────────────────────────────────────────────────────────────────
function Listening(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const l = p.page.extra?.listening;
  const max = Math.max(1, ...(l?.countries ?? []).map((c) => c.share));
  const line = lineOf(p.page, "line");
  return (
    <View style={[s.pad, { flex: 1, paddingTop: p.top + 12 * z, paddingBottom: p.bottom }]}>
      <Reveal arrival={a} order={0}><Title z={z}>{eyebrowOf(p)}</Title></Reveal>
      <Reveal arrival={a} order={1}><Line text={line} slot="line" onLine={p.onLine} style={[s.line, { color: Bold.ink, fontSize: fitSize(line, 20 * z, 90), lineHeight: fitSize(line, 20 * z, 90) * 1.25 }]} lines={6} /></Reveal>
      {l?.channels.length ? (
        <Reveal arrival={a} order={2} style={[s.tiles, { marginTop: 12 * z }]}>
          {channelRows(l.channels).slice(0, 2).map((c) => (
            <View key={c.platform} style={s.tile}>
              <Text style={[s.label, { color: Bold.mute, marginTop: 0 }]}>{c.platform}</Text>
              {c.followers ? <Text style={[s.tileBig, { fontSize: 34 * z, lineHeight: 38 * z }]}>{c.followers}</Text> : null}
              <Text style={[s.fact, { color: Bold.mute }]}>followers</Text>
              {c.stats.map((x) => <Text key={x.label} style={[s.fact, { color: Bold.ink2 }]} numberOfLines={1}>{x.value} {x.label}</Text>)}
            </View>
          ))}
        </Reveal>
      ) : null}
      {l?.countries.length ? (
        <Reveal arrival={a} order={3} style={{ marginTop: 14 * z, gap: 7 }}>
          <Label dark={false}>{C.where}</Label>
          {l.countries.slice(0, 3).map((c, i) => (
            <View key={c.label} style={s.barRow}>
              <Text style={[s.barName, { color: Bold.ink2, width: 44 }]}>{c.label}</Text>
              <View style={s.barTrack}><GrowBar pct={(c.share / max) * 100} color={Bold.ink} active={p.active} reduce={p.reduce} delay={300 + i * 80} style={s.barFill} /></View>
              <Text style={[s.barScore, { color: Bold.ink }]}>{c.share}%</Text>
            </View>
          ))}
        </Reveal>
      ) : null}
      {l?.posts.length ? (
        <Reveal arrival={a} order={4} style={{ marginTop: 14 * z }}>
          <Label dark={false}>{C.strongest}</Label>
          <View style={s.posts}>
            {l.posts.slice(0, 3).map((x, i) => (
              <View key={i} style={{ flex: 1 }}>
                <Image source={{ uri: x.image }} style={s.postImg} resizeMode="cover" />
                <Text style={[s.fact, { color: Bold.ink, fontFamily: W700 }]} numberOfLines={1}>{postStats(x.likes, null)}</Text>
                <Text style={[s.fact, { color: Bold.mute, marginTop: 0 }]}>{platformName(x.platform)}</Text>
              </View>
            ))}
          </View>
        </Reveal>
      ) : null}
    </View>
  );
}

// ── Voice and look (gallery) ─────────────────────────────────────────────────────────────────────────────────────────
function VoiceLook(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const photos = p.page.images.slice(p.rp.rows[0], p.rp.rows[1]);
  const say = sayLines(p.page)[0];
  const line = lineOf(p.page, "line");
  const lineSize = fitSize(line, 17 * z, 110);
  return (
    <View style={[s.pad, { flex: 1, paddingTop: p.top + 12 * z, paddingBottom: p.bottom }]}>
      <Reveal arrival={a} order={0}><Title z={z}>{eyebrowOf(p)}</Title></Reveal>
      <Reveal arrival={a} order={1}><Line text={line} slot="line" onLine={p.onLine} style={[s.read, { fontSize: lineSize, lineHeight: lineSize * 1.38, marginBottom: 12 * z }]} lines={6} /></Reveal>
      {photos.length ? (
        <Reveal arrival={a} order={2} style={s.grid}>
          {photos.map((u) => <Image key={u} source={{ uri: u }} style={[s.gridPhoto, { width: (p.w - 4) / 2, height: Math.min((p.w - 4) / 2.6, p.h * 0.18) }]} resizeMode="cover" />)}
        </Reveal>
      ) : null}
      {p.page.extra?.palette?.length ? (
        <Reveal arrival={a} order={3} style={[s.paletteRow, { marginVertical: 12 * z }]}>
          <Label dark={false}>{C.palette}</Label>
          <View style={s.swatches}>
            {p.page.extra.palette.slice(0, 5).map((hex) => <View key={hex} style={[s.swatch, { backgroundColor: hex, width: 26 * z, height: 26 * z, borderRadius: 13 * z }]} accessibilityLabel={hex} />)}
          </View>
        </Reveal>
      ) : null}
      {say ? (
        <Reveal arrival={a} order={4} style={[s.softCard, s.sayCard, { marginTop: p.page.extra?.palette?.length ? 0 : 12 * z }]}>
          <Text style={s.quoteMark}>“</Text>
          <View style={{ flex: 1 }}>
            <Label dark={false}>{C.sayIt}</Label>
            <Line text={say.text} slot={say.slot} onLine={p.onLine} style={[s.herWords, { fontSize: 17 * z, lineHeight: 23 * z }]} lines={3} />
          </View>
        </Reveal>
      ) : null}
    </View>
  );
}

// ── What we'll stay away from (list) ─────────────────────────────────────────────────────────────────────────────────
function Avoid(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const gs = (p.page.extra?.guardrails ?? []).slice(p.rp.rows[0], p.rp.rows[1]);
  const line = lineOf(p.page, "line");
  return (
    <View style={[s.pad, { flex: 1, paddingTop: p.top + 12 * z, paddingBottom: p.bottom }]}>
      <Reveal arrival={a} order={0}><Title z={z}>{eyebrowOf(p)}</Title></Reveal>
      {p.rp.part.i === 0 ? <Reveal arrival={a} order={1}><Line text={line} slot="line" onLine={p.onLine} style={[s.statement, { color: Bold.ink, fontSize: fitSize(line, 24 * z, 70), lineHeight: fitSize(line, 24 * z, 70) * 1.18 }]} lines={7} /></Reveal> : null}
      {gs.map((g, i) => (
        <Reveal key={i} arrival={a} order={2 + i}>
          <Rule dark={false} />
          <Label dark={false}>{guardrailSource(g)}</Label>
          <Text style={[s.body, { color: Bold.ink2, fontSize: 15 * z, lineHeight: 21.5 * z }]} numberOfLines={4}>{g.text}</Text>
        </Reveal>
      ))}
    </View>
  );
}

// ── Your commercial position (rates) ─────────────────────────────────────────────────────────────────────────────────
function Rates(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const rates = (p.page.extra?.commercial?.rates ?? []).slice(p.rp.rows[0], p.rp.rows[1]);
  const first = p.rp.part.i === 0;
  const line = lineOf(p.page, "line");
  return (
    <View style={[s.pad, { flex: 1, paddingTop: p.top + 12 * z, paddingBottom: p.bottom }]}>
      <Reveal arrival={a} order={0}><Title z={z}>{eyebrowOf(p)}</Title></Reveal>
      <Reveal arrival={a} order={0} style={s.private}><Feather name="lock" size={11} color={Bold.mute} /><Text style={[s.label, { color: Bold.mute, marginVertical: 0 }]}>{C.privateTag}</Text></Reveal>
      {first ? <Reveal arrival={a} order={1}><Line text={line} slot="line" onLine={p.onLine} style={[s.statement, { color: Bold.ink, fontSize: fitSize(line, 24 * z, 70), lineHeight: fitSize(line, 24 * z, 70) * 1.18 }]} lines={6} /></Reveal> : null}
      <Reveal arrival={a} order={2} style={{ marginTop: 8 * z }}>
        <Label dark={false}>{C.rates}</Label>
        {rates.map((r) => {
          const row = rateRow(r);
          return (
            <View key={r.rateType} style={[s.rate, { paddingVertical: 8 * z }]}>
              <Text style={[s.body, { color: Bold.ink2, flex: 1, fontSize: 14.5 * z }]} numberOfLines={1}>{row.label}</Text>
              <View style={{ alignItems: "flex-end" }}>
                {row.range ? <Text style={[s.rateRange, { fontSize: 19 * z }]}>{row.range}</Text> : null}
                {row.minimum
                  ? <Text style={[s.fact, { color: Bold.mute }]}>{row.minimum} {C.yourMin}</Text>
                  : (
                    <Pressable onPress={() => { haptics.tap(); p.go("YourRates"); }} accessibilityRole="button" style={s.minChip}>
                      <Text style={s.minChipText}>{C.setMin}</Text>
                    </Pressable>
                  )}
              </View>
            </View>
          );
        })}
      </Reveal>
    </View>
  );
}

function Partners(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const c = p.page.extra?.commercial;
  return (
    <View style={[s.pad, { flex: 1, paddingTop: p.top + 12 * z, paddingBottom: p.bottom }]}>
      <Reveal arrival={a} order={0}><Title z={z}>{C.partners}</Title></Reveal>
      {(c?.partners ?? []).slice(0, 5).map((x, i) => (
        <Reveal key={x.name} arrival={a} order={1 + i} style={[s.partner, { paddingVertical: 9 * z }]}>
          <View style={s.logo}>
            {x.logoUrl ? <Image source={{ uri: x.logoUrl }} style={s.logoImg} resizeMode="contain" /> : <Text style={s.logoInitial}>{x.name.charAt(0).toUpperCase()}</Text>}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.partnerName, { fontSize: 18 * z }]} numberOfLines={1}>{x.name}</Text>
            {x.category ? <Text style={[s.fact, { color: Bold.mute }]} numberOfLines={1}>{[x.category, x.tier].filter(Boolean).join(" · ")}</Text> : null}
          </View>
        </Reveal>
      ))}
      {c?.inbound.length ? (
        <Reveal arrival={a} order={7} style={{ marginTop: 16 * z }}>
          <Label dark={false}>{C.inbound}</Label>
          <View style={s.chips}>{c.inbound.slice(0, 8).map((x) => <Text key={x.category} style={s.chip}>{x.category} · {x.count}</Text>)}</View>
        </Reveal>
      ) : null}
    </View>
  );
}

// ── The plan (live goals under a photo band) ─────────────────────────────────────────────────────────────────────────
function Plan(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const goals = useAgentGoalsPlan(true);
  const writeGoal = useGoalWrite();
  const rows = planRows(goals.data, horizonLabel);
  const bg = p.rp.backdrop ?? p.rp.image;
  const eyebrow = lineOf(p.page, "eyebrow");
  const line = lineOf(p.page, "line");
  const lineSize = fitSize(line, 18 * z, 90);
  // One screen: her goals first, then what Mila suggests — two cards at most; the rest is one tap away.
  const cards = [...rows.goals.map((g) => ({ kind: "goal" as const, g })), ...rows.suggested.map((sg) => ({ kind: "suggest" as const, sg }))].slice(0, 2);
  return (
    <View style={{ flex: 1 }}>
      {bg ? (
        <Band uri={bg} h={p.h * 0.36} active={p.active} reduce={p.reduce}>
          <View style={[s.pad, s.bandFoot]}>
            {eyebrow ? <Reveal arrival={a} order={0}><PhotoChip>{eyebrow}</PhotoChip></Reveal> : null}
            <Reveal arrival={a} order={0}><Text style={[s.bandTitle, { fontSize: 42 * z, lineHeight: 40 * z }]} numberOfLines={2}>{p.page.title.toUpperCase()}</Text></Reveal>
          </View>
        </Band>
      ) : (
        <View style={[s.pad, { paddingTop: p.top + 12 * z }]}>
          <Reveal arrival={a} order={0}><Title z={z}>{eyebrow ?? p.page.title}</Title></Reveal>
        </View>
      )}
      <View style={[s.pad, { flex: 1, paddingTop: 14 * z, paddingBottom: p.bottom + (p.end ? 30 : 0) }]}>
        <Reveal arrival={a} order={1}><Line text={line} slot="line" onLine={p.onLine} style={[s.line, { color: Bold.ink, fontSize: lineSize, lineHeight: lineSize * 1.3, marginBottom: 2 }]} lines={4} /></Reveal>
        {goals.isLoading ? <ActivityIndicator color={Bold.ink} style={{ marginTop: 12 }} /> : null}
        {!goals.isLoading && !cards.length ? <Text style={[s.body, { color: Bold.mute, marginTop: 10, fontSize: 15, lineHeight: 21 }]}>{C.planEmpty}</Text> : null}
        {cards.map((c, i) => c.kind === "goal" ? (
          <Reveal key={c.g.id} arrival={a} order={2 + i} style={[s.goalCard, { padding: 14 * z }]}>
            <Text style={[s.label, { color: Bold.mute, marginTop: 0 }]}>{["Your goal", c.g.horizon].filter(Boolean).join(" · ")}</Text>
            <Text style={[s.goalText, { fontSize: 18 * z, lineHeight: 22 * z }]} numberOfLines={3}>{c.g.text}</Text>
            {c.g.posts > 0 ? (
              <Pressable onPress={() => p.go("Studio")} accessibilityRole="button" style={s.goalLink}>
                <Text style={s.goalLinkText}>{C.postsReady(c.g.posts)} · {C.openStudio}</Text>
                <Feather name="arrow-right" size={13} color={Bold.ink} />
              </Pressable>
            ) : null}
          </Reveal>
        ) : (
          <Reveal key={c.sg.decisionId} arrival={a} order={2 + i} style={[s.goalCard, { padding: 14 * z }]}>
            <Text style={[s.label, { color: Bold.mute, marginTop: 0 }]}>{[C.suggests, c.sg.horizon].filter(Boolean).join(" · ")}</Text>
            <Text style={[s.goalText, { fontSize: 18 * z, lineHeight: 22 * z }]} numberOfLines={3}>{c.sg.text}</Text>
            <View style={s.goalBtns}>
              <Pressable onPress={() => { haptics.press(); writeGoal.mutate({ op: "keep", decisionId: c.sg.decisionId }); }} style={s.keepBtn} accessibilityRole="button" disabled={writeGoal.isPending}>
                <Text style={s.keepText}>{C.keep}</Text>
              </Pressable>
              <Pressable onPress={() => { haptics.tap(); writeGoal.mutate({ op: "skip", decisionId: c.sg.decisionId }); }} style={s.notNow} accessibilityRole="button" disabled={writeGoal.isPending}>
                <Text style={s.notNowText}>{C.notNow}</Text>
              </Pressable>
            </View>
          </Reveal>
        ))}
        <Pressable onPress={() => p.go("Plan")} accessibilityRole="button" style={[s.goalLink, { marginTop: 12 }]}>
          <Text style={s.goalLinkText}>{C.manageGoals}</Text>
          <Feather name="arrow-right" size={13} color={Bold.ink} />
        </Pressable>
      </View>
    </View>
  );
}

// ── That's your brand (the closing page) ─────────────────────────────────────────────────────────────────────────────
function Close(p: PageProps & { dark: boolean }) {
  const a = useArrival(p.active, p.reduce);
  const z = k(p.h);
  const close = lineOf(p.page, "line");
  const dark = p.dark;
  const size = fitSize(close, 34 * z, 44);
  return (
    <View style={{ flex: 1 }}>
      {p.rp.image ? <Bleed uri={p.rp.image} active={p.active} reduce={p.reduce} from={0.4} /> : null}
      {/* Room above the footer, which steps up over the reel button on the last page. */}
      <View style={[s.pad, { flex: 1, justifyContent: "flex-end", paddingBottom: p.bottom + 40 }]}>
        <Reveal arrival={a} order={0}>{dark ? <PhotoChip>{C.closeEyebrow}</PhotoChip> : <Title z={z}>{C.closeEyebrow}</Title>}</Reveal>
        <Reveal arrival={a} order={1}><Line text={close} slot="line" onLine={p.onLine} style={[s.statement, { color: ink(dark), fontSize: size, lineHeight: size * 1.12 }]} lines={5} /></Reveal>
        {p.onShare ? (
          <Reveal arrival={a} order={3}>
            <Pressable onPress={() => { haptics.tap(); p.onShare?.(); }} accessibilityRole="button" style={[s.shareBtn, { borderColor: ink(dark) }]} testID="book-close-share">
              <Feather name="share" size={14} color={ink(dark)} />
              <Text style={[s.shareText, { color: ink(dark) }]}>{C.sharePage}</Text>
            </Pressable>
          </Reveal>
        ) : null}
        <Reveal arrival={a} order={4}><Text style={[s.fact, { color: mute(dark), marginTop: 12, fontSize: 13, lineHeight: 18 }]}>{C.closeNote}</Text></Reveal>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { overflow: "hidden" },
  pad: { paddingHorizontal: Bold.gutter },
  title: { fontFamily: W900, color: Bold.ink, letterSpacing: -1, textTransform: "uppercase", marginBottom: 12 },
  photoChipWrap: { alignSelf: "flex-start", backgroundColor: Bold.paper, borderRadius: Bold.radius.chip, height: 28, paddingHorizontal: 12, justifyContent: "center", marginBottom: 12 },
  photoChip: { ...BoldType.label, color: Bold.ink },
  rule: { height: 1, marginVertical: 14 },
  label: { ...BoldType.label, marginTop: 6, marginBottom: 6 },
  meta: { fontFamily: W500, fontSize: 13, lineHeight: 18, color: Bold.onDarkLabel, marginTop: 12 },

  coverName: { fontFamily: W900, color: Bold.onDark, letterSpacing: -2.5, marginBottom: 14 },
  coverLine: { fontFamily: W700, color: Bold.onDark },
  line: { fontFamily: W700 },
  read: { fontFamily: W500, color: Bold.ink2 },
  statement: { fontFamily: W800, letterSpacing: -0.4, marginBottom: 6 },
  body: { fontFamily: outfitFamily("400") },
  fact: { fontFamily: W500, fontSize: 12, lineHeight: 17, marginTop: 4 },
  herWords: { fontFamily: W600, color: Bold.ink },

  scoreCard: { backgroundColor: DARK, borderRadius: Bold.radius.card, padding: 16, flexDirection: "row", alignItems: "center", gap: 16 },
  legend: { flexDirection: "column", rowGap: 5 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  barName: { fontFamily: W500, fontSize: 14, width: 150 },
  barTrack: { flex: 1, height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: Bold.track },
  barFill: { height: 6, borderRadius: 3 },
  barScore: { fontFamily: W800, fontSize: 14, width: 32, textAlign: "right" },

  numeral: { fontFamily: W900, color: Bold.ink, letterSpacing: -3, marginBottom: 4 },
  pillarName: { fontFamily: W900, letterSpacing: -1, textTransform: "uppercase" },

  inset: { overflow: "hidden", marginHorizontal: -Bold.gutter, marginBottom: 8, backgroundColor: Bold.ground },
  beat: { flexDirection: "row", gap: 14, borderTopWidth: 1, borderTopColor: Bold.line },
  beatDate: { fontFamily: W900, color: Bold.ink, width: 56, letterSpacing: -0.5 },
  beatLine: { fontFamily: W600, color: Bold.ink },

  tiles: { flexDirection: "row", gap: 10 },
  tile: { flex: 1, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, padding: 14, backgroundColor: Bold.paper },
  tileBig: { fontFamily: W900, color: Bold.ink, letterSpacing: -1, marginTop: 4 },
  posts: { flexDirection: "row", gap: 4 },
  postImg: { width: "100%", aspectRatio: 4 / 5, backgroundColor: Bold.ground },

  paletteRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  swatches: { flexDirection: "row", gap: 8 },
  swatch: { borderWidth: 1, borderColor: "rgba(0,0,0,0.12)" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginHorizontal: -Bold.gutter },
  gridPhoto: { backgroundColor: Bold.ground },
  softCard: { backgroundColor: Bold.ground, borderRadius: Bold.radius.card },
  sayCard: { flexDirection: "row", gap: 10, paddingVertical: 14, paddingHorizontal: 16 },
  quoteMark: { fontFamily: W900, fontSize: 44, lineHeight: 44, color: Bold.act, marginTop: -2 },

  private: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
  rate: { flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  rateRange: { fontFamily: W900, color: Bold.ink, letterSpacing: -0.4 },
  minChip: { backgroundColor: Bold.act, borderRadius: Bold.radius.pill, paddingHorizontal: 12, height: 28, justifyContent: "center", marginTop: 4 },
  minChipText: { ...BoldType.buttonSmall, color: Bold.onAct },

  partner: { flexDirection: "row", alignItems: "center", gap: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  logo: { width: 44, height: 44, borderRadius: 22, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  logoImg: { width: 28, height: 28 },
  logoInitial: { fontFamily: W900, fontSize: 19, color: Bold.ink },
  partnerName: { fontFamily: W800, color: Bold.ink },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { fontFamily: W700, fontSize: 12, color: Bold.ink, backgroundColor: Bold.ground, borderRadius: Bold.radius.pill, paddingHorizontal: 12, paddingVertical: 7, overflow: "hidden" },
  chipOnDark: { color: Bold.onDark, backgroundColor: "rgba(0,0,0,0.35)", borderWidth: 1, borderColor: "rgba(255,255,255,0.45)" },
  shareBtn: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", borderWidth: 1.5, borderRadius: Bold.radius.pill, height: 44, paddingHorizontal: 20, marginTop: 14 },
  shareText: { ...BoldType.button },

  bandFoot: { position: "absolute", left: 0, right: 0, bottom: 16 },
  bandTitle: { fontFamily: W900, color: Bold.onDark, letterSpacing: -1.4 },
  goalCard: { borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, marginTop: 10, backgroundColor: Bold.paper },
  goalText: { fontFamily: W800, color: Bold.ink, marginTop: 2 },
  goalLink: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, minHeight: 28 },
  goalLinkText: { ...BoldType.button, fontSize: 12, color: Bold.ink },
  goalBtns: { flexDirection: "row", gap: 10, marginTop: 12 },
  keepBtn: { backgroundColor: Bold.act, borderRadius: Bold.radius.pill, height: 44, paddingHorizontal: 22, alignItems: "center", justifyContent: "center" },
  keepText: { ...BoldType.button, color: Bold.onAct },
  notNow: { borderRadius: Bold.radius.pill, height: 44, paddingHorizontal: 20, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: Bold.ink },
  notNowText: { ...BoldType.button, color: Bold.ink },
});
