/**
 * testUtils/agentModel.ts — a fake OpenAI Responses transport for the agent skills, and athlete fixtures.
 *
 * Tests never reach a provider: setResponsesTransport(fakeResponses(handler)) answers every structured call from
 * `handler`, which sees the request body (instructions, input, schema name, tools) and returns the JSON the "model"
 * says, the sources its "searches" saw, and its usage. Not a *.test.ts file, so jest does not collect it.
 *
 * Fixtures: made-up athletes across stages and sports (a youth athlete, a college athlete, a pro). None is a real
 * person; nothing in the code under test may depend on any of them.
 */
import type { ResponsesTransport } from "../agent/research/llm";

export interface FakeAnswer {
  json: unknown;
  sources?: Array<{ url: string; title?: string }>;
  queries?: string[];
  usage?: { input?: number; cached?: number; output?: number; reasoning?: number };
  /** Raw text instead of JSON (to test a broken answer). */
  rawText?: string;
}

export type FakeHandler = (body: Record<string, any>) => FakeAnswer | Promise<FakeAnswer>;

export interface FakeTransport extends ResponsesTransport {
  calls: Array<Record<string, any>>;
}

export function fakeResponses(handler: FakeHandler): FakeTransport {
  const calls: Array<Record<string, any>> = [];
  return {
    calls,
    async create(params) {
      calls.push(params);
      const a = await handler(params);
      const queries = a.queries ?? (a.sources?.length ? ["fake query"] : []);
      const output: any[] = queries.map((q, i) => ({
        type: "web_search_call", id: `ws_${i}`, status: "completed",
        action: { type: "search", query: q, sources: i === 0 ? (a.sources ?? []).map((s) => ({ type: "url", url: s.url, title: s.title })) : [] },
      }));
      output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: a.rawText ?? JSON.stringify(a.json), annotations: [] }] });
      const response = {
        id: `resp_${calls.length}`, status: "completed", output,
        usage: {
          input_tokens: a.usage?.input ?? 1000, input_tokens_details: { cached_tokens: a.usage?.cached ?? 0 },
          output_tokens: a.usage?.output ?? 200, output_tokens_details: { reasoning_tokens: a.usage?.reasoning ?? 50 },
        },
      };
      // Stream like the API: each finished web_search item, the answer text in two deltas, then the completed response.
      const text = a.rawText ?? JSON.stringify(a.json);
      const half = Math.floor(text.length / 2);
      return (async function* () {
        for (const item of output.filter((o) => o.type === "web_search_call")) yield { type: "response.output_item.done", item };
        yield { type: "response.output_text.delta", delta: text.slice(0, half) };
        yield { type: "response.output_text.delta", delta: text.slice(half) };
        yield { type: "response.completed", response };
      })();
    },
  };
}

/** The skill a request is for, from its prompt-cache key ("nomila:<skill id>@<version>"). */
export const skillOf = (body: Record<string, any>): string => String(body.prompt_cache_key ?? "").replace(/^nomila:/, "").replace(/@.*$/, "");

export interface AthleteFixture {
  name: string;
  sport: string;
  stage: "youth" | "college" | "pro";
  ageBand: "under_18" | "18_plus";
  /** Pages a "search" finds, and what they say. */
  pages: Array<{ url: string; title: string; claim: string; topic: string; date: string; subjectKind?: string; subjectName?: string; sensitivity?: "none" | "care" | "never"; neverReason?: string }>;
}

export const FIXTURES: Record<"youth" | "college" | "pro", AthleteFixture> = {
  youth: {
    name: "Jordan Vale", sport: "volleyball", stage: "youth", ageBand: "under_18",
    pages: [
      { url: "https://www.example-hs-athletics.org/volleyball/roster/jordan-vale", title: "Varsity roster", claim: "Jordan Vale plays outside hitter on the varsity volleyball team (2026 season).", topic: "team", date: "2026-09" },
      { url: "https://www.example-local-news.com/sports/vale-all-district", title: "All-district team named", claim: "Jordan Vale was named to the all-district first team in 2025.", topic: "achievement", date: "2025-11-20" },
      { url: "https://www.example-local-news.com/community/vale-family", title: "Family feature", claim: "Jordan Vale's younger sibling also plays volleyball.", topic: "other", date: "2025-06-01", sensitivity: "never", neverReason: "child_identity" },
    ],
  },
  college: {
    name: "Priya Natarajan", sport: "swimming", stage: "college", ageBand: "18_plus",
    pages: [
      { url: "https://example-university-athletics.edu/sports/swimming/roster/priya-natarajan", title: "Swimming roster", claim: "Priya Natarajan is a junior on the university swimming team (2026–27).", topic: "team", date: "2026-09" },
      { url: "https://www.example-swim-news.com/results/conference-2026", title: "Conference championships", claim: "Priya Natarajan won the 200 butterfly at the 2026 conference championships.", topic: "achievement", date: "2026-02-28" },
      { url: "https://www.example-brand-press.com/news/local-ambassadors", title: "Local ambassadors", claim: "Priya Natarajan appeared in a 2025 campaign for a regional sportswear shop (one-off; current status unclear).", topic: "sponsor", date: "2025-05" },
    ],
  },
  pro: {
    name: "Tomasz Reyes", sport: "basketball", stage: "pro", ageBand: "18_plus",
    pages: [
      { url: "https://www.example-pro-league.com/players/tomasz-reyes", title: "Player profile", claim: "Tomasz Reyes is a guard for a professional basketball club (2026 season).", topic: "team", date: "2026-10" },
      { url: "https://www.example-sports-wire.com/reyes-shoe-deal", title: "Footwear deal", claim: "Tomasz Reyes signed a multi-year footwear endorsement in 2024.", topic: "sponsor", date: "2024-03-01" },
      { url: "https://www.example-sports-wire.com/reyes-allstar", title: "All-star selection", claim: "Tomasz Reyes was selected as an all-star in 2026.", topic: "achievement", date: "2026-02-10" },
    ],
  },
};

/** A research pass answer for a fixture: every page as a fact with its URL; the "search" saw every page. */
export function passAnswer(f: AthleteFixture, opts: { skip?: number; extra?: FakeAnswer["json"][] } = {}): FakeAnswer {
  const pages = f.pages.slice(opts.skip ?? 0);
  return {
    sources: f.pages.map((p) => ({ url: `${p.url}?utm_source=openai`, title: p.title })),
    json: {
      identity: { resolved: true, description: `${f.name}, ${f.sport}`, ambiguity: "" },
      facts: [
        ...pages.map((p) => ({ subject_kind: p.subjectKind ?? "athlete", subject_name: p.subjectName ?? f.name, claim: p.claim, topic: p.topic, source_url: p.url, source_title: p.title, source_type: "official", date: p.date, confidence: 0.9, sensitivity: p.sensitivity ?? "none", care_kind: p.sensitivity === "care" ? "personal" : "none", never_reason: p.neverReason ?? "none" })),
        ...(opts.extra ?? []),
      ],
      gaps: ["eligibility rules for this athlete's school/association"],
      narrative: `${f.name} plays ${f.sport}.`,
    },
  };
}

/**
 * A tool result as an engine sends it, parsed: an ok result arrives fenced as outside text
 * (`<external_content>` … `</external_content>`), the engine's own replies as plain JSON.
 */
export function toolOutputJson(output: string): any {
  const m = /^<external_content>\n([\s\S]*)\n<\/external_content>$/.exec(output);
  return JSON.parse(m ? m[1] : output);
}

/** A skill's run input without the transport's `<inputs …>` fence (jobs.ts fenceSkillInput), for tests that read it. */
export function unfencedInput(input: unknown): string {
  const m = /^<inputs[^>]*>\n([\s\S]*)\n<\/inputs>$/.exec(String(input ?? ""));
  return m ? m[1] : String(input ?? "");
}
