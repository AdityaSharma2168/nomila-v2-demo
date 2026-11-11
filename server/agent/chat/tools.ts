/**
 * agent/chat/tools.ts — the chat's tools over memory (design "Mila's chat skill" §3), each with its permission:
 *
 *   recall_facts         read     facts beyond the context block, by query / topic / subject_kind; each gets an F-key
 *   remember_fact        propose  something durable the athlete told Mila — QUEUED: "Want me to save that?"; saved as a
 *                                 said fact only on their Save tap (never by the model)
 *   correct_fact         propose  the athlete says a fact is wrong — QUEUED; on the tap their words supersede it (the
 *                                 same path as PATCH /me/facts/:id: history and review kept, what used it re-runs)
 *   remember_preference  propose  how they want things done / what to avoid / a standing rule / a never-use name —
 *                                 QUEUED; saved on the tap. Exempt from the never-term check for its own avoid statement
 *   cite_facts           read     the F-keys the answer rests on → "How I got this" (code builds it from these)
 *   read_scouting        read     the Scouting report's detail (scouting/1), no model call
 *   offer_connection     read     a connect card for a connector that is not connected; at most once a conversation
 *   ask_quick_question   read     a quick-question card with 2–4 tap answers
 *   open_screen          read     a tap-to-open card for one screen from a FIXED allow-list (shared OPEN_SCREENS)
 *
 * Cards come from code (what the tool did), never from the model's prose. No tool takes an athlete id: the athlete is
 * the run's (ToolContext). A propose tool's call never runs here: the policy queues it (confirm_first) and only the
 * athlete's tap — POST /pending-actions/:id/approve → executeAgentAction — runs `execute`.
 */
import { z } from "zod";
import {
  FACT_TYPES, OPEN_SCREENS, PREFERENCE_KINDS, SCOUTING_SECTIONS, SUBJECT_KINDS,
  type ChatCard, type EvidenceRef, type MemoryFact, type OpenScreen, type PreferenceKind,
} from "../../../shared/agent";
import { cleanNewFact, FactHygieneError } from "../factHygiene";
import { CONNECTORS } from "../onboarding/catalog";
import { checkFactSource } from "../policy";
import type { AgentStore } from "../research/store";
import { errorResult, okResult, resolveFactKeys, type AgentTool, type ToolContext } from "../tools";
import { foundAge, meaningfulWords, unconfirmedReport } from "./context";
import type { ChatSources } from "./sources";
import { GAME_TOPIC } from "../events/games";

/** remember_fact's refusal for an event without a date: what Mila does next. */
export const EVENT_NEEDS_DATE = "an event is saved only with the date they said: ask them when it is (YYYY-MM-DD), then offer to save it";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const sameWords = (a: string, b: string) => oneLine(a).toLowerCase().replace(/[.!]+$/, "") === oneLine(b).toLowerCase().replace(/[.!]+$/, "");

/** The key a fact has in this turn (from the context block), or a new one. */
function keyFor(ctx: ToolContext, factId: string): string | null {
  const keys = ctx.turn?.factKeys;
  if (!keys) return null;
  for (const [k, id] of keys) if (id === factId) return k;
  const next = `F${keys.size + 1}`;
  keys.set(next, factId);
  return next;
}

const PREF_TITLES: Record<PreferenceKind, string> = {
  voice: "How you want to sound",
  style: "How you like things done",
  avoid: "What to stay away from",
  standing_rule: "A standing rule",
};

const SCREEN_LABELS: Record<OpenScreen, string> = {
  home: "Home", goals: "Your goals", goal: "Your goal", me: "Me", scouting: "Your scouting report", knows: "What Nomila knows",
};
const SECTION_LABELS: Record<(typeof SCOUTING_SECTIONS)[number], string> = {
  mia: "your M.I.A.", working_for_you: "what's working for you", room_to_grow: "room to grow", brands: "your brands", defines: "what defines you",
};

export function chatTools(store: AgentStore, sources: ChatSources): AgentTool[] {
  // ── recall_facts ────────────────────────────────────────────────────────────────────────────────────────────────
  const recallFacts: AgentTool = {
    name: "recall_facts",
    description: "Facts about the athlete beyond the CONTEXT block, filtered: `query` (words to match in the subject, claim or topic), `topic` (e.g. sponsor, career, media), `subject_kind`. Each fact comes back with a key you can cite. Use only when CONTEXT does not hold what the answer needs; never page through everything.",
    kind: "ours", permission: "read",
    args: z.object({
      query: z.string().max(200).optional().describe("Words to look for, e.g. a brand or event name."),
      topic: z.string().max(40).optional().describe("A research topic: career, sponsor, media, honours, academics, interests, upcoming …"),
      subject_kind: z.enum(SUBJECT_KINDS).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("How many facts (default 20)."),
    }),
    async execute(ctx, a: { query?: string; topic?: string; subject_kind?: string; limit?: number }) {
      let facts = await store.listFacts(ctx.athleteId, ["active", "disputed"]);
      if (a.topic?.trim()) facts = facts.filter((f) => (f.topic ?? "").toLowerCase() === a.topic!.trim().toLowerCase());
      if (a.subject_kind) facts = facts.filter((f) => f.subject.kind === a.subject_kind);
      const newest = (x: MemoryFact, y: MemoryFact) => y.createdAt.localeCompare(x.createdAt);
      if (a.query?.trim()) {
        const words = meaningfulWords(a.query);
        const q = oneLine(a.query).toLowerCase();
        facts = facts.map((f) => {
          const hay = oneLine(`${f.subject.name} ${f.claim} ${f.topic ?? ""}`).toLowerCase();
          return { f, n: words.filter((w) => hay.includes(w)).length + (q.length >= 3 && hay.includes(q) ? 2 : 0) };
        }).filter((x) => x.n > 0).sort((x, y) => y.n - x.n || newest(x.f, y.f)).map((x) => x.f);
      } else {
        facts = facts.sort(newest);
      }
      const picked = facts.slice(0, a.limit ?? 20);
      const today = ctx.turn?.today ?? new Date().toISOString().slice(0, 10);
      return okResult({
        count: picked.length,
        facts: picked.map((f) => {
          // A found fact carries its age; a found care fact is an unconfirmed report naming its outlet (principle 9).
          const age = foundAge(f, today);
          const report = unconfirmedReport(f);
          return {
            ...(ctx.turn ? { key: keyFor(ctx, f.id) } : { id: f.id }),
            type: f.type, subject: `${f.subject.kind}: ${f.subject.name}`, claim: f.claim, date: f.date, topic: f.topic ?? null,
            ...(age ? { age_days: age.days, age: age.words } : {}),
            ...(f.status === "disputed" ? { disputed: true } : {}), ...(f.sensitive ? { care: true } : {}),
            ...(report ? { unconfirmed: true, source: { title: report.title, host: report.host } } : {}),
          };
        }),
      });
    },
    evidence(result, ctx): EvidenceRef[] {
      const facts = (result as { facts?: Array<{ id?: string; key?: string }> })?.facts ?? [];
      const ids = facts.flatMap((f) => (f.id ? [f.id] : f.key ? resolveFactKeys(ctx, [f.key]) : []));
      return ids.map((factId) => ({ kind: "fact", factId }));
    },
  };

  // ── remember_fact (propose) ─────────────────────────────────────────────────────────────────────────────────────
  const factArgs = z.object({
    subject_kind: z.enum(SUBJECT_KINDS),
    subject_name: z.string().min(1).max(200).describe("Who or what it is about (the athlete's own name for a fact about them)."),
    claim: z.string().min(1).max(2000).describe("One sentence, in the athlete's own words where you can."),
    date: z.string().regex(DAY_RE).optional().describe("When it was true or happens, YYYY-MM-DD. For an event (subject_kind event) this is required: the date they said, never today's by default; if they did not say when, ask them first."),
    game: z.boolean().optional().describe("subject_kind event only: true when they said it is a game, match or competition they play in."),
    type: z.enum(FACT_TYPES).optional().describe("Leave unset: something the athlete told you is 'said'."),
    source_url: z.string().max(2000).optional(),
    source_title: z.string().max(300).optional(),
    confidence: z.number().min(0).max(1).optional(),
  });
  type FactArgs = z.infer<typeof factArgs>;
  /** A fact the athlete told Mila in the chat is sourced to the run that offered it ("chat:run:<id>#said"). */
  const sourceOf = (a: FactArgs, runId: string) => ({
    ...(a.source_url ? { url: a.source_url } : { ref: `chat:run:${runId}#said` }),
    ...(a.source_title ? { title: a.source_title } : (a.type ?? "said") === "said" ? { title: "You told me" } : {}),
  });
  const rememberFact: AgentTool<typeof factArgs> = {
    name: "remember_fact",
    description: "Offer to save one durable thing the athlete told you about themselves or their business (a result, a new partner and its dates, a team move, an event, a plan). It is NOT saved by this call: the athlete sees \"Want me to save that?\" and it is saved only if they tap Save. An event (a game, a meet, a launch) needs the date they said: if they did not say when, ask them before you call this. Set game true when they say it is a game, match or competition they play in. Never contact details, addresses, other people's private details or children's names.",
    kind: "ours", permission: "propose",
    args: factArgs,
    approval: {
      verb: "save_memory",
      title: () => "Something you told me",
      summary: (a: FactArgs) => `${oneLine(a.claim)}${a.date ? ` (${a.date})` : ""}`,
    },
    async prepare(ctx, a) {
      const type = a.type ?? "said";
      // An event is saved only with the date they said (a game "today" by default would read as already happening and
      // never as coming up): no date, no save — ask them.
      if (a.subject_kind === "event" && !a.date) return { error: EVENT_NEEDS_DATE };
      if (a.game && a.subject_kind !== "event") return { error: "game is only for an event (subject_kind event)" };
      const args: FactArgs = {
        ...a, type, confidence: a.confidence ?? (type === "said" ? 1 : 0.8),
        date: a.date ?? ctx.turn?.today ?? new Date().toISOString().slice(0, 10),
      };
      const source = sourceOf(args, ctx.runId);
      try { cleanNewFact({ subject: { kind: args.subject_kind, name: args.subject_name }, claim: args.claim, type, source, date: args.date ?? null, confidence: args.confidence!, runId: null }); }
      catch (err) { return { error: err instanceof FactHygieneError ? err.message : "that can't be saved as a fact" }; }
      const verdict = checkFactSource(source);
      if (verdict.decision !== "allow") return { error: verdict.reason };
      const held = await store.listFacts(ctx.athleteId, ["active", "disputed"]);
      if (held.some((f) => sameWords(f.claim, args.claim))) return { error: "that is already in memory: nothing to save" };
      return { args };
    },
    async execute(ctx, a) {
      const [fact] = await store.insertFacts(ctx.athleteId, [{
        subject: { kind: a.subject_kind, name: a.subject_name }, claim: a.claim, type: a.type ?? "said",
        source: sourceOf(a, ctx.runId), date: a.date ?? null, confidence: a.confidence ?? 1, runId: ctx.runId || null,
        // A game they named (agent/events/games.ts isGameFact): the moments store reads it like any dated event.
        ...(a.subject_kind === "event" && a.game ? { topic: GAME_TOPIC } : {}),
      }]);
      return fact ? okResult({ saved: true, claim: fact.claim }) : errorResult("it could not be saved");
    },
  };

  // ── correct_fact (propose) ──────────────────────────────────────────────────────────────────────────────────────
  const correctArgs = z.object({
    fact: z.string().min(1).max(80).describe("The F-key of the fact that is wrong."),
    claim: z.string().min(1).max(2000).describe("What is right, in the athlete's words."),
    date: z.string().regex(DAY_RE).optional(),
  });
  const correctFact: AgentTool<typeof correctArgs> = {
    name: "correct_fact",
    description: "Offer to correct a fact the athlete says is wrong (name its F-key). It is NOT changed by this call: they see the correction and it is saved only if they tap Save; the old fact's history is kept. If it is new information rather than a correction, use remember_fact; if it is unclear which fact is meant, ask.",
    kind: "ours", permission: "propose",
    args: correctArgs,
    approval: { verb: "save_memory", title: () => "A correction", summary: (a) => `${oneLine(a.claim)}${a.date ? ` (${a.date})` : ""}` },
    async prepare(ctx, a) {
      const [id] = resolveFactKeys(ctx, [a.fact]);
      if (!id) return { error: "that key is not one of the athlete's facts in this conversation" };
      const [f] = await store.getFacts(ctx.athleteId, [id]);
      if (!f || (f.status !== "active" && f.status !== "disputed")) return { error: "that fact is no longer current" };
      if (f.type === "measured") return { error: "that number comes from a connected account and updates from there" };
      if (sameWords(f.claim, a.claim)) return { error: "that is what memory already says" };
      return { args: { ...a, fact: id } };
    },
    async execute(ctx, a) {
      try {
        await sources.correctFact(ctx.athleteId, a.fact, { claim: a.claim, date: a.date ?? null });
        return okResult({ corrected: true, claim: a.claim });
      } catch (err: any) {
        return errorResult(String(err?.message ?? "it could not be corrected"));
      }
    },
  };

  // ── remember_preference (propose) ───────────────────────────────────────────────────────────────────────────────
  const prefArgs = z.object({
    kind: z.enum(PREFERENCE_KINDS).describe("voice | style (how they want things done), avoid (what to stay away from, or a never-use name), standing_rule"),
    statement: z.string().min(1).max(500).describe("In their words. A name never to use is written \"Never use: Name\"."),
  });
  const rememberPreference: AgentTool<typeof prefArgs> = {
    name: "remember_preference",
    description: "Offer to save how the athlete wants things done, what to stay away from, a standing rule, or a name never to use (\"Never use: Name\"). Only what they TOLD you, never a pattern you noticed. It is NOT saved by this call: they see \"Want me to save that?\" and it is saved only if they tap Save.",
    kind: "ours", permission: "propose",
    args: prefArgs,
    approval: { verb: "save_memory", title: (a) => PREF_TITLES[a.kind as PreferenceKind], summary: (a) => oneLine(a.statement) },
    // The never-use list is maintained through this tool: its own avoid statement skips the never-term check.
    neverTermExempt: (a) => (a.kind === "avoid" ? ["statement"] : []),
    async prepare(ctx, a) {
      let statement = oneLine(a.statement);
      const m = /^never\s+(use|name|mention)\s*[:\-–—]?\s*(.+)$/i.exec(statement);
      if (a.kind === "avoid" && m) statement = `Never use: ${m[2].replace(/[.]+$/, "")}`;
      const held = await sources.preferences(ctx.athleteId).catch(() => []);
      if (held.some((p) => p.status === "active" && p.kind === a.kind && sameWords(p.statement, statement))) return { error: "that preference is already held: nothing to save" };
      return { args: { kind: a.kind, statement } };
    },
    async execute(ctx, a) {
      await sources.addPreference(ctx.athleteId, { kind: a.kind as PreferenceKind, statement: a.statement }, ctx.runId || null);
      return okResult({ saved: true, kind: a.kind });
    },
  };

  // ── cite_facts ──────────────────────────────────────────────────────────────────────────────────────────────────
  const citeFacts: AgentTool = {
    name: "cite_facts",
    description: "Name the F-keys your answer rests on, once, when the answer states facts about the athlete. Code builds \"How I got this\" from exactly these (plus any web pages you used). Not for opinion or small talk.",
    kind: "ours", permission: "read",
    args: z.object({ keys: z.array(z.string().max(12)).min(1).max(15).describe("F-keys, e.g. [\"F2\", \"F7\"].") }),
    async execute(ctx, a: { keys: string[] }) {
      const valid = a.keys.map((k) => k.trim().toUpperCase()).filter((k, i, all) => ctx.turn?.factKeys.has(k) && all.indexOf(k) === i);
      if (!valid.length) return errorResult("none of those keys are facts in this conversation");
      return okResult({ cited: valid, ignored: a.keys.length - valid.length });
    },
    cites(result, ctx): EvidenceRef[] {
      const keys = (result as { cited?: string[] })?.cited ?? [];
      return resolveFactKeys(ctx, keys).map((factId) => ({ kind: "fact", factId }));
    },
  };

  // ── read_scouting ───────────────────────────────────────────────────────────────────────────────────────────────
  const readScouting: AgentTool = {
    name: "read_scouting",
    description: "The Scouting report in detail: the M.I.A. read (score, preliminary, confidence), every note on what is working for the athlete, room to grow and what is not on record yet (each with its dimension), their brands (current, past, unclear) and conflicts. Use when they ask why their M.I.A. is what it is, what holds them back, or about their partners, and CONTEXT is not enough.",
    kind: "ours", permission: "read",
    args: z.object({}),
    async execute(ctx) {
      const r = await sources.scouting(ctx.athleteId);
      if (r.status === "no_memory") return okResult({ report: "none yet", why: "nothing is on record about the athlete yet" });
      const notes = r.notes?.detail;
      const n = (x: { text: string; dimension: string | null }) => ({ note: x.text, dimension: x.dimension });
      const brand = (b: { name: string; startedOn: string | null; latestConfirmedOn: string | null }) => ({ name: b.name, since: b.startedOn, last_confirmed: b.latestConfirmedOn });
      return okResult({
        report: r.status === "ready" ? "ready" : "no Brief yet",
        stage: r.hero.stage, positioning: r.hero.statement,
        mia: r.mia ? { score: r.mia.score, scale: "0–850", preliminary: r.mia.preliminary, confidence: r.mia.confidence?.level ?? null, status: r.mia.status } : null,
        working_for_you: notes?.strengths.map(n) ?? [], room_to_grow: notes?.growth.map(n) ?? [], not_on_record_yet: notes?.missing.map(n) ?? [],
        brands: { current: r.brands.current.map(brand), past: r.brands.past.map(brand), unclear: r.brands.unclear.map(brand) },
        conflicts: r.conflicts.map((c) => ({ what: c.what, blocks: c.blocks })),
        defines: r.defines ? { today: r.defines.today, headed: r.defines.headed, pillars: r.defines.pillars.map((p) => p.label) } : null,
      });
    },
  };

  // ── offer_connection ────────────────────────────────────────────────────────────────────────────────────────────
  const offerConnection: AgentTool = {
    name: "offer_connection",
    description: "Show a connect card for one account when connecting it would directly sharpen the answer the athlete just asked for and CONNECTED says it can be offered now. Give the reason for THIS question. At most once a conversation.",
    kind: "ours", permission: "read",
    args: z.object({
      connector: z.enum(CONNECTORS.map((c) => c.id) as [string, ...string[]]),
      why: z.string().min(1).max(300).describe("One reason, specific to what they just asked."),
    }),
    async execute(ctx, a: { connector: string; why: string }) {
      const entry = CONNECTORS.find((c) => c.id === a.connector)!;
      const connected = await sources.connected(ctx.athleteId).catch(() => []);
      if (connected.some((c) => c.id === entry.id)) return errorResult(`${entry.service} is already connected`);
      if (ctx.turn && ctx.turn.offeredConnectors.length) return errorResult("a connection was already offered in this conversation: do not offer another");
      ctx.turn?.offeredConnectors.push(entry.id);
      return okResult({ offered: entry.id, service: entry.service, access: entry.access, why: oneLine(a.why) });
    },
    card(result, ctx): ChatCard | null {
      const r = result as { offered?: string; service?: string; access?: string[]; why?: string };
      if (!r.offered) return null;
      return {
        id: `connect:${ctx.runId}:${r.offered}`, kind: "connect", title: `Connect ${r.service}?`,
        payload: { connectorId: r.offered, service: r.service!, access: r.access ?? [], why: r.why ?? "" },
        links: [{ label: "Connect", target: { screen: "connect", id: r.offered } }], runId: ctx.runId,
      };
    },
  };

  // ── ask_quick_question ──────────────────────────────────────────────────────────────────────────────────────────
  const askQuickQuestion: AgentTool = {
    name: "ask_quick_question",
    description: "Ask one question only the athlete can answer, with 2–4 short tap answers that cover it (e.g. This month · This quarter · This year). Their tap comes back as their next message. An open question is one plain sentence instead.",
    kind: "ours", permission: "read",
    args: z.object({
      question: z.string().min(1).max(200),
      options: z.array(z.string().min(1).max(40)).min(2).max(4),
      why: z.string().max(200).optional(),
    }),
    async execute(_ctx, a: { question: string; options: string[]; why?: string }) {
      const options = [...new Set(a.options.map(oneLine).filter(Boolean))];
      if (options.length < 2) return errorResult("a quick question needs at least two different answers");
      return okResult({ asked: oneLine(a.question), options });
    },
    card(result, ctx): ChatCard | null {
      const r = result as { asked?: string; options?: string[] };
      if (!r.asked) return null;
      return { id: `quick:${ctx.runId}`, kind: "quick-question", title: "Quick question", payload: { question: r.asked, options: r.options ?? [], why: "" }, links: [], runId: ctx.runId };
    },
  };

  // ── open_screen ─────────────────────────────────────────────────────────────────────────────────────────────────
  const openScreen: AgentTool = {
    name: "open_screen",
    description: "Show a tap-to-open card for one app screen when the athlete would be better served there: home, goals, goal (pass goal_id), me, scouting (optionally a section: mia, working_for_you, room_to_grow, brands, defines), knows (What Nomila knows). Nothing else can be opened.",
    kind: "ours", permission: "read",
    args: z.object({
      screen: z.enum(OPEN_SCREENS),
      goal_id: z.string().max(80).optional().describe("For screen goal: the goal's G-id."),
      section: z.enum(SCOUTING_SECTIONS).optional().describe("For screen scouting."),
      why: z.string().max(200).optional(),
    }),
    async execute(ctx, a: { screen: OpenScreen; goal_id?: string; section?: (typeof SCOUTING_SECTIONS)[number]; why?: string }) {
      let id: string | null = null;
      let label = SCREEN_LABELS[a.screen];
      if (a.screen === "goal") {
        const goalId = String(a.goal_id ?? "").replace(/^G:/i, "").trim();
        const goal = goalId ? await store.getGoal(ctx.athleteId, goalId) : null;
        if (!goal || goal.status === "dropped") return errorResult("that is not one of the athlete's goals");
        id = goal.id;
        label = clip(oneLine(goal.text), 60);
      } else if (a.screen === "scouting" && a.section) {
        id = a.section;
        label = `${SCREEN_LABELS.scouting}: ${SECTION_LABELS[a.section]}`;
      }
      return okResult({ screen: a.screen, id, label, why: oneLine(a.why ?? "") });
    },
    card(result, ctx): ChatCard | null {
      const r = result as { screen?: OpenScreen; id?: string | null; label?: string; why?: string };
      if (!r.screen) return null;
      return {
        id: `open:${ctx.runId}:${r.screen}:${r.id ?? ""}`, kind: "open-screen", title: r.label!,
        payload: { screen: r.screen, id: r.id ?? null, label: r.label!, why: r.why ?? "" },
        links: [{ label: `Open ${r.label}`, target: { screen: r.screen, ...(r.id ? { id: r.id } : {}) } }], runId: ctx.runId,
      };
    },
  };

  return [recallFacts, rememberFact as unknown as AgentTool, correctFact as unknown as AgentTool, rememberPreference as unknown as AgentTool, citeFacts, readScouting, offerConnection, askQuickQuestion, openScreen];
}
