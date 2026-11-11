/**
 * brandBook/pages — the brand book's TEMPLATE: which chapters exist for an athlete, what facts each shows, which images
 * it holds, and what it asks the copywriter for. Templates own structure; the copywriter owns the crafted lines; her own
 * records own the facts. A chapter with nothing true to show is left out — a data-poor athlete gets a shorter book, never
 * an invented one. No chapter repeats another's facts.
 *
 *   1 cover        her promise, over her photo
 *   2 found        the read of record: score, the eight dimensions, strengths, thin spots, the opportunity
 *   3 big_idea     the positioning, from → to, where the brand stands now and goes next
 *   4 pillars      each pillar with its evidence
 *   5 story        dated milestones, each with what it opened
 *   6 listening    her channels' numbers, where her audience is, her own strongest posts
 *   7 voice_look   her palette and her photos; how she sounds
 *   8 avoid        what the brand stays away from (her own words, contracts, the read's risk)
 *   9 commercial   her rates (live), the brands she works with, the kinds of brands that come to her — private
 *  10 plan         the season's push; her goals are read live by the app
 *  11 close        "That's your brand": one closing line over her portrait, the reel and share actions
 *
 * Pure: sources in, briefs and pages out. Nothing here names an athlete, sport, school or brand.
 */
import type {
  BookChannel, BookDimension, BookGuardrail, BookLine, BookPage, BookPartner, BookPost, BrandBookPageId,
} from "../../../shared/brandBook";
import type { BookBrief, ChipFacts } from "./copy";

/** Everything the book is built from, already read. Images are bucket paths. */
export interface BookSources {
  firstName: string;
  /** The read of record (null when she has none, or it is withheld). */
  found: { score: number | null; asOf: string | null; dimensions: BookDimension[]; strengths: string[]; thin: string[] } | null;
  /** The Brief's biggest upside: the opportunity line. */
  opportunity: string | null;
  /** Positioning: statement, from → to, pillars with their evidence line; the Brief's now / next. */
  positioning: { statement?: string; from?: string; to?: string; pillars: Array<{ name: string; line: string }> };
  nowNext: { now: string | null; next: string | null };
  /** Dated milestones, oldest first ("2024-10", fact). */
  milestones: Array<{ date: string; fact: string }>;
  /** Her connected channels' latest numbers, and where her audience is. */
  channels: BookChannel[];
  countries: Array<{ label: string; share: number }>;
  /** Her own strongest posts (she is in them). */
  posts: BookPost[];
  /** Her palette, measured from her photos. */
  palette: string[];
  /** Her confirmed voice, when she has one. */
  voice: { tone?: string; phrases?: string[] } | null;
  /** Her own recent captions (register for the voice chapter). */
  captions: string[];
  guardrails: BookGuardrail[];
  partners: BookPartner[];
  inbound: Array<{ category: string; count: number }>;
  /** She has rates on file (suggested or her own minimum): the commercial chapter has a spine. */
  hasRates: boolean;
  /** Goals and next moments, as one line each, for the plan chapter's crafted headline only (the app reads them live). */
  goals: string[];
  moments: Array<{ date: string; name: string }>;
  /**
   * Images cast per photo slot from that slot's brief (photoBriefsFor → curator castBriefs), keyed by slot. A null or
   * missing slot means nothing in her library passed the gates: the page is drawn type-led, never with a weak photo.
   */
  images: Record<string, string | null>;
  /** Each cast slot's tier (curator CastTier): "strong" matches the theme, "decent" passed the gates with a weaker match. */
  imageTiers?: Record<string, "strong" | "decent" | "atmosphere">;
  /** Toned versions of statement slots' photos (big_idea, plan), drawn BEHIND the page's line. Absent = none. */
  backdrops?: Record<string, string>;
}

/**
 * The photo brief for every slot the book may draw, written from that page's own words — no model. The theme comes
 * from the page (the big idea's statement, each pillar's name and evidence, the latest milestone, where the season is
 * going), and the slot's role adds the framing (a cover is a portrait facing the camera, a pillar is her in action).
 * The curator matches each against the library's embeddings. Pure.
 */
export function photoBriefsFor(s: Pick<BookSources, "positioning" | "milestones" | "nowNext" | "goals">): Array<{ key: string; query: string; needFace?: boolean; role?: "key" | "decor" }> {
  const cut = (t: string | undefined | null, n = 160) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  // Key slots (cover, big idea, pillars, story) carry the page's argument; decor slots (voice gallery, close, plan
  // backdrop) are cast after them and take what is left (curator castBriefs).
  const out: Array<{ key: string; query: string; needFace?: boolean; role?: "key" | "decor" }> = [];
  out.push({ key: "cover", needFace: true,
    query: `confident hero portrait of the athlete facing the camera, clean uncluttered background, premium editorial; ${cut(s.positioning.statement, 120)}` });
  if (s.positioning.statement) out.push({ key: "big_idea", needFace: true,
    query: `the athlete embodying this idea, striking and purposeful: ${cut(s.positioning.statement)}` });
  s.positioning.pillars.slice(0, 3).forEach((p, i) => out.push({ key: `pillar.${i}`,
    query: `the athlete showing ${cut(p.name, 60)}: ${cut(p.line, 140)}` }));
  const latest = s.milestones[s.milestones.length - 1];
  if (latest) out.push({ key: "story", query: `the athlete at the moment of: ${cut(latest.fact)}` });
  // Voice and look: four different sides of her, so the strip reads as a personality, not four of the same shot.
  ["candid, natural moment that shows her personality, smiling", "the athlete in competition, in motion",
    "off the field, everyday life and style", "close portrait, warm light"].forEach((q, i) => out.push({ key: `voice.${i}`, query: q, needFace: i === 3, role: "decor" }));
  out.push({ key: "close", needFace: true, role: "decor",
    query: `the athlete looking ahead, confident and composed, portrait, vertical; ${cut(s.positioning.statement, 100)}` });
  const ahead = s.nowNext.next ?? s.goals[0];
  out.push({ key: "plan", role: "decor", query: `looking ahead, the athlete ready for what's next${ahead ? `: ${cut(ahead)}` : ""}` });
  return out;
}

const TITLES: Record<BrandBookPageId, string> = {
  cover: "Your brand book", found: "What we found", big_idea: "The big idea", pillars: "Your pillars", story: "Your story",
  listening: "Who's listening", voice_look: "Your voice and look", avoid: "What we'll stay away from",
  commercial: "Your commercial position", plan: "The plan", close: "That's your brand",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2024-10…" → "Oct 2024"; a bare year stays a year. */
export function monthYear(date: string): string {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(date);
  if (!m) return date;
  return m[2] ? `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`.trim() : m[1];
}

const scored = (s: BookSources) => (s.found?.dimensions ?? []).filter((d) => d.score != null);

/** Which chapters this athlete's book has, in order, given what is true about her. */
export function pagesFor(s: BookSources): BrandBookPageId[] {
  const out: BrandBookPageId[] = ["cover"];
  if (s.found && scored(s).length >= 3) out.push("found");
  if (s.positioning.statement) out.push("big_idea");
  if (s.positioning.pillars.length >= 2) out.push("pillars");
  if (s.milestones.length >= 2) out.push("story");
  if (s.channels.length || s.posts.length) out.push("listening");
  if (s.palette.length >= 2 || s.captions.length >= 2 || s.voice) out.push("voice_look");
  if (s.guardrails.length) out.push("avoid");
  if (s.hasRates || s.partners.length || s.inbound.length) out.push("commercial");
  out.push("plan");
  out.push("close");
  return out;
}

/**
 * The stored facts each pillar's evidence chips may draw on, by pillar index: that pillar's own evidence line (the
 * words) and her dated milestones (a year may date a fact the evidence names). chipBacked (copy.ts) drops any chip
 * these do not back. Pure.
 */
export function chipFactsFor(s: Pick<BookSources, "positioning" | "milestones">): ChipFacts[] {
  const dated = s.milestones.map((m) => `${m.date.slice(0, 4)} ${m.fact}`);
  return s.positioning.pillars.slice(0, 3).map((p) => ({ evidence: p.line, dated }));
}

const pillarsOf = (s: BookSources) => s.positioning.pillars.slice(0, 3);
const momentsLine = (m: { date: string; name: string }) => `${m.date} — ${m.name}`;
const DIM_WORDS: Record<string, string> = {
  athletic_authority: "athletic authority", audience_scale: "audience scale", engagement_quality: "engagement quality",
  cultural_relevance: "cultural relevance", narrative_power: "narrative power", brand_fit: "brand fit",
  commercial_proof: "commercial proof", momentum: "momentum",
};
const dimLine = (d: BookDimension) => `${DIM_WORDS[d.key] ?? d.key.replace(/_/g, " ")} ${d.score}/100`;

/**
 * The read lines the book shows as-is (written about her in the third person by research and the read of record), in a
 * fixed order: each is restated to her as "you" by the copywriter, facts unchanged (restateLines in copy.ts). Pure.
 */
export function readLines(s: BookSources): string[] {
  const pages = pagesFor(s);
  const out: string[] = [];
  if (pages.includes("found")) out.push(...(s.found?.strengths ?? []), ...(s.found?.thin ?? []), ...(s.opportunity ? [s.opportunity] : []));
  if (pages.includes("big_idea")) out.push(...[s.positioning.statement, s.positioning.from, s.positioning.to, s.nowNext.next].filter((x): x is string => !!x));
  if (pages.includes("pillars")) out.push(...pillarsOf(s).map((p) => p.line));
  if (pages.includes("story")) out.push(...s.milestones.map((m) => m.fact));
  if (pages.includes("avoid")) out.push(...s.guardrails.map((g) => g.text));
  return [...new Set(out)];
}

/** Apply the restated lines (original → restated) to the sources, so every chapter shows them. Pure. */
export function withRestated(s: BookSources, map: Map<string, string>): BookSources {
  const r = (t: string) => map.get(t) ?? t;
  const ro = (t: string | undefined) => (t ? r(t) : t);
  return {
    ...s,
    found: s.found ? { ...s.found, strengths: s.found.strengths.map(r), thin: s.found.thin.map(r) } : null,
    opportunity: s.opportunity ? r(s.opportunity) : null,
    positioning: { ...s.positioning, statement: ro(s.positioning.statement), from: ro(s.positioning.from), to: ro(s.positioning.to), pillars: s.positioning.pillars.map((p) => ({ ...p, line: r(p.line) })) },
    nowNext: { now: s.nowNext.now ? r(s.nowNext.now) : null, next: s.nowNext.next ? r(s.nowNext.next) : null },
    guardrails: s.guardrails.map((g) => ({ ...g, text: r(g.text) })),
    milestones: s.milestones.map((m) => ({ ...m, fact: r(m.fact) })),
  };
}

/** What each chapter asks the copywriter for. */
export function bookBriefs(s: BookSources): BookBrief[] {
  const briefs: BookBrief[] = [];
  for (const page of pagesFor(s)) {
    const label = TITLES[page];
    if (page === "cover") briefs.push({ page, label, slots: [{ kind: "line", key: "line", max: 120 }], factsShown: [s.firstName],
      intent: "The brand book's opening line: the ONE promise the athlete's brand makes, written to the athlete as you — what people can count on from you wherever you show up. Not a description and not a goal. One line." });
    if (page === "found") {
      const dims = scored(s).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      briefs.push({ page, label, slots: [{ kind: "line", key: "line", max: 140 }],
        factsShown: ["the eight marketability dimensions as a chart", "the read's strengths and thin spots as lists", s.opportunity ? "the opportunity as a line" : ""].filter(Boolean),
        intent: `line = the agency's honest one-line diagnosis to you, after studying everything: where your brand is strong right now and what is holding it back — frank, the way an agency talks to its own client, never flattering and never alarming. The read, strongest first: ${dims.map(dimLine).join(", ")}. Strengths: ${(s.found?.strengths ?? []).slice(0, 3).join(" · ") || "none listed"}. Thin spots: ${(s.found?.thin ?? []).slice(0, 3).join(" · ") || "none listed"}.` });
    }
    if (page === "big_idea") briefs.push({ page, label, slots: [{ kind: "line", key: "line", max: 120 }],
      factsShown: ["the positioning statement as a paragraph beneath it", "the from → to line", s.nowNext.now || s.nowNext.next ? "where your brand stands now and goes next" : ""].filter(Boolean),
      intent: "The ONE line naming the idea the athlete's whole brand turns on — the idea every pillar, post and partnership hangs from. Sharper than the paragraph beneath it, never a summary of it. One line." });
    if (page === "pillars") {
      const facts = chipFactsFor(s);
      briefs.push({ page, label, slots: [{ kind: "set", key: "pillar", count: pillarsOf(s).length, fields: ["name", "proof", "chips"], max: 140 }],
        factsShown: ["each pillar's evidence as a line under it"],
        intent: `The athlete's ${pillarsOf(s).length} brand pillars, in the order the context gives them (keep each pillar's territory). For each: a NAME of two to four words that the athlete could own, and ONE proof line that says what the evidence proves about them — the meaning, not the list of facts (the evidence lines already show those). chips = 2 or 3 short evidence tags for that pillar, each at most three words, naming something that pillar's OWN evidence says (a role, an honour, a team, a partner, a programme), in its words — a year from the dated milestones may date it. Never a judgement, never a fact from another pillar's territory, never one that is not in these records. ${facts.map((f, i) => `[pillar ${i}] evidence: ${f.evidence}`).join(" ; ")} ; dated milestones: ${facts[0]?.dated.join(" | ") ?? ""}` });
    }
    if (page === "story") {
      const beats = s.milestones.map((m, i) => `[${i}] ${m.date} — ${m.fact}`).join("; ");
      briefs.push({ page, label, slots: [{ kind: "set", key: "beat", count: s.milestones.length, max: 140 }, { kind: "line", key: "line", max: 120 }],
        factsShown: ["each milestone's date and plain fact, on a timeline"],
        intent: `beat = ONE crafted line per milestone below, in order — what that moment meant or opened, not what happened (the date and fact already sit on the timeline). Read together they are chapters building to now. line = the ONE closing line under the timeline: the payoff that says these are chapters, not highlights. Earned, quiet, not grand. Milestones: ${beats}` });
    }
    if (page === "listening") briefs.push({ page, label, slots: [{ kind: "line", key: "line", max: 120 }],
      factsShown: ["each channel's followers, reach, engagement and views as numbers", s.countries.length ? "where your audience is, as bars" : "", s.posts.length ? "your strongest posts with their likes" : ""].filter(Boolean),
      intent: "line = who already follows you and what your strongest posts prove about them — the people already here, not a demographic to chase. What the numbers MEAN, earned and real, never a number itself." });
    if (page === "voice_look") briefs.push({ page, label, slots: [{ kind: "line", key: "line", max: 120 }, { kind: "set", key: "say", count: 3, max: 140 }],
      factsShown: [s.palette.length ? "your palette as swatches, measured from your own photos" : "", "your photos", s.voice?.tone ? `your confirmed voice: ${s.voice.tone}` : ""].filter(Boolean),
      intent: "line = how your brand looks and sounds, in one line — the feel your own photos and colours give and the register you already write in (your own captions above). Never name a colour, place or object you are not given. say = three short example lines in that register, the way you would caption a moment — fresh lines, never copied from your captions, never a number or claim that is not in the context." });
    if (page === "avoid") briefs.push({ page, label, slots: [{ kind: "line", key: "line", max: 120 }],
      factsShown: s.guardrails.map((g) => g.text),
      intent: "line = the ONE principle behind what your brand stays away from — why saying no protects the brand. Grounded only in the guardrails shown; never add a new one." });
    if (page === "commercial") briefs.push({ page, label, slots: [{ kind: "line", key: "line", max: 120 }],
      factsShown: ["your rate ranges and your minimums as numbers", s.partners.length ? "the brands you work with" : "", s.inbound.length ? "the kinds of brands that come to you, with counts" : ""].filter(Boolean),
      intent: "line = where you stand commercially right now, said plainly to you: the kind of partnership you are ready for and why. Private to you. Never a price, never a brand name." });
    if (page === "plan") briefs.push({ page, label, slots: [{ kind: "line", key: "eyebrow", max: 34 }, { kind: "line", key: "line", max: 120 }],
      factsShown: [...s.goals, ...s.moments.map(momentsLine)],
      intent: "eyebrow = a label for the plan chapter. line = what this season is for, so the goals below read as one push toward the big idea, not a to-do list." });
    if (page === "close") briefs.push({ page, label, slots: [{ kind: "line", key: "line", max: 90 }],
      factsShown: [s.firstName],
      intent: "line = the book's last page, under \"That's your brand\": ONE closing line that sends you out with your brand in a few words — grounded in the big idea and your promise, a different line from the cover's promise, screenshot-worthy. Two short sentences at most." });
  }
  return briefs;
}

/** The chapters, with her facts, her images and the crafted lines. A chapter keeps its facts even when a line came back empty. */
export function assemblePages(s: BookSources, lines: Partial<Record<BrandBookPageId, Record<string, BookLine>>>): BookPage[] {
  // Images: each slot's own cast photo (photoBriefsFor). A slot with none is drawn type-led.
  const img = (...keys: string[]): string[] => keys.map((k) => s.images[k]).filter((x): x is string => !!x);
  const tiersOf = (...keys: string[]) => keys.filter((k) => s.images[k]).map((k) => s.imageTiers?.[k] ?? "strong");

  // The closing page exists only with its crafted line: an empty "That's your brand" page is filler.
  return pagesFor(s).filter((id) => id !== "close" || !!lines.close?.line).map((id): BookPage => {
    const page: BookPage = { id, title: TITLES[id], lines: lines[id] ?? {}, facts: [], images: [] };
    switch (id) {
      case "cover": page.images = img("cover"); page.facts = [s.firstName]; break;
      case "found":
        page.extra = { found: { ...s.found!, opportunity: s.opportunity } };
        break;
      case "big_idea":
        page.images = img("big_idea");
        page.extra = { idea: {
          statement: s.positioning.statement ?? null, from: s.positioning.from ?? null, to: s.positioning.to ?? null,
          now: s.nowNext.now, next: s.nowNext.next,
        } };
        break;
      case "pillars":
        // One photo per pillar, in pillar order; a pillar with none keeps its slot empty (type-led), never shifted.
        page.images = pillarsOf(s).map((_, i) => s.images[`pillar.${i}`] ?? "");
        page.extra = { evidence: pillarsOf(s).map((p) => p.line) };
        // Without a crafted name, the pillar keeps its own name (structure, not invention).
        pillarsOf(s).forEach((p, i) => { if (!page.lines[`pillar.${i}.name`]) page.lines[`pillar.${i}.name`] = { text: p.name, options: [p.name] }; });
        break;
      case "story":
        page.images = img("story");
        page.extra = { milestones: s.milestones };
        break;
      case "listening":
        page.images = s.posts.map((p) => p.image);
        page.extra = { listening: { channels: s.channels, countries: s.countries, posts: s.posts } };
        break;
      case "voice_look":
        page.images = img("voice.0", "voice.1", "voice.2", "voice.3");
        page.extra = { palette: s.palette };
        page.facts = s.voice?.tone ? [s.voice.tone] : [];
        break;
      case "avoid": page.extra = { guardrails: s.guardrails }; break;
      case "commercial": page.extra = { commercial: { rates: [], partners: s.partners, inbound: s.inbound } }; break;
      case "plan": page.images = img("plan"); break;
      case "close": page.images = img("close"); page.facts = [s.firstName]; break;
    }
    // Each image's tier, parallel to page.images (pillars keep their positions, "" where a pillar is type-led).
    const keysFor: Partial<Record<BrandBookPageId, string[]>> = {
      cover: ["cover"], big_idea: ["big_idea"], story: ["story"], plan: ["plan"], close: ["close"],
      voice_look: ["voice.0", "voice.1", "voice.2", "voice.3"],
    };
    if (id === "pillars") page.imageTiers = pillarsOf(s).map((_, i) => (s.images[`pillar.${i}`] ? s.imageTiers?.[`pillar.${i}`] ?? "strong" : ""));
    else if (keysFor[id] && page.images.length) page.imageTiers = tiersOf(...keysFor[id]!);
    // Statement pages: the toned version of their photo, drawn behind the line.
    if ((id === "big_idea" || id === "plan") && s.backdrops?.[id]) page.backdrop = s.backdrops[id];
    // A cover with no usable photo of the athlete: type-led over a toned place from the atmosphere library.
    else if (id === "cover" && !page.images.length && s.backdrops?.cover) page.backdrop = s.backdrops.cover;
    return page;
  });
}
