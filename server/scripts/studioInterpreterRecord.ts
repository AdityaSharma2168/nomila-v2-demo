/**
 * studioInterpreterRecord — R1: record the interpreter's replies, once, for tests and the preview-decision
 * diff to replay (the interpreter, I.3; plan v1 §7 "Paid recon", "Recorded replies").
 *
 * About 45 sentences: the corpus's asks, the neighbourhoods of the four acceptance sentences, and the ad,
 * conditional, preservation and headline classes. Each is sent once through the PRODUCT transport — the
 * same prompt, model, output type, thinking and timeout a preview uses — against the Q1 frame, and the
 * raw reply is written to a recording keyed by PROMPT_VERSION (server/studio/interpret/recorded.ts). It
 * also answers the two things R1 exists to measure beside the replies: tokens and latency per call.
 *
 * DRY RUN IS THE DEFAULT. It prints every sentence, what route() does with it today (a sentence that
 * already routes is never sent — the interpreter never sees it), the prompt's size and the quote, and it
 * makes NO call and reads NO row. `--run` sends; `--cap` refuses a call that would carry the estimated
 * total past it.
 *
 *   npx tsx --require dotenv/config server/scripts/studioInterpreterRecord.ts
 *   npx tsx --require dotenv/config server/scripts/studioInterpreterRecord.ts --run --cap 0.25
 *   npx tsx --require dotenv/config server/scripts/studioInterpreterRecord.ts --run --only 1 --cap 0.01
 *
 * ⚠️ THE FIRST CALL IS A PREFLIGHT, AND A FAILURE IS NAMED, NOT A BARE 400. Before anything is recorded it
 * prints the wire the product sends — model, location, every generation-config field — beside the request
 * detection and QA send daily on this project, then sends the product's exact request once
 * (interpret/transport.ts, `interpreterRequest`). If Vertex refuses it, the script prints Vertex's WHOLE
 * error and walks back toward detection's request one differing field at a time, stopping at the first
 * that is accepted — which names the field. Nothing else is sent. (interpret/1's first call came back 400
 * INVALID_ARGUMENT, and this script printed only the first 200 characters of why — 2026-09-14.)
 *
 * READ-ONLY: one SELECT of the frame's stored path under the athlete id, and a signed GCS read. Nothing is
 * written anywhere but the recording file.
 */
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { route } from "../studio/classify";
import { probeBytesFor } from "../studio/autoMask";
import {
  displayTextEnabled,
  interpreterModel,
  interpreterTimeoutMs,
} from "../studio/config";
import { genai, GEMINI } from "../lib/models";
import { withTimeout } from "../lib/withTimeout";
import { adPlan, adTreatment } from "../studio/interpret/ad";
import { brandIdForName } from "../studio/interpret/brandName";
import { getBrandContext } from "../services/shotList";
import { db } from "../db";
import { athletes } from "../../shared/schema";
import { eq } from "drizzle-orm";
import {
  propose,
  type AthleteRegister,
  type MenuSwitches,
} from "../studio/interpret/core";
import { interpretableAsk } from "../studio/interpret/eligibility";
import { PROMPT_VERSION, interpreterPrompt } from "../studio/interpret/prompt";
import {
  recordedInput,
  type Recording,
  type RecordedReply,
} from "../studio/interpret/recorded";
import {
  geminiTransport,
  interpreterRequest,
  type TransportUsage,
} from "../studio/interpret/transport";
import {
  preflight,
  wireLines,
  type SendResult,
  type WireRequest,
} from "../studio/interpret/preflight";

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const CAP_USD = Number(arg("cap", "0.25"));
const ONLY = arg("only") ? Number(arg("only")) : null;
/** Adi's own athlete row — the only one this touches (read-only). */
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
/** The Q1 frame: 1008x1476, Nike jersey, socks and cleats — the frame acceptance cells 1a and 4 use. */
const FRAME_ID = arg("frame", "afc78262-f4ce-4637-bc26-658b5f63ca0e")!;
const OUT = arg("out", "server/studio/interpret/fixtures/r1.json")!;
const OUT_SCENE = arg(
  "out-scene",
  "server/studio/interpret/fixtures/scene.json",
)!;
const MENU: MenuSwitches = {
  text: !flag("text-off"),
  exclusion: !flag("exclusion-off"),
};

// ─── THE CLASSIFIER'S SWITCHES ARE SET TO MATCH THE MENU, AND CHECKED ──────────────────────────────
//
// The menu offers a headline; route() reads one only with STUDIO_DISPLAY_TEXT on (PR T — the switch is
// read inside the classifier, at call time). A recording whose menu says `text` while route() cannot read
// a headline replays as round-trip mismatches that are not the model's doing — R1's first run was exactly
// that. So the switch is set here to the menu's value before anything is classified, and asserted, and the
// header says which it was. In the product the two cannot disagree: the route builds the menu from
// `displayTextEnabled()` itself (I.5).
if (MENU.text) process.env.STUDIO_DISPLAY_TEXT = "true";
else delete process.env.STUDIO_DISPLAY_TEXT;
if (displayTextEnabled() !== MENU.text) {
  throw new Error(
    `menu text=${MENU.text} but the classifier reads STUDIO_DISPLAY_TEXT as ${displayTextEnabled()} — refusing to record`,
  );
}

/**
 * An estimate per call at QA's Flash rates (studio/qa/cost.ts): ~2.5k tokens in (prompt + a 1024px
 * probe), up to ~600 out with thinking. Conservative, so the cap stops early rather than late.
 */
const QUOTE_PER_CALL_USD = 0.004;

// ─── The sentences ──────────────────────────────────────────────────────────────────────────────

/**
 * ─── THE SCENE SET (wave C) — fixtures/scene.json's 30 sentences, recorded by the SAME RUN ──────
 *
 * `scene.json` had no recorder in the repo. It came from `tools/am/sceneProbe.ts`, which lives outside
 * the worktree, writes somewhere else, and only ever sent twelve of these — so the fixture could not be
 * regenerated from anything committed, and a PROMPT_VERSION bump left `scene.test.ts` permanently red
 * with no way back. **A red suite does not merge**, so the list is rebuilt here from the fixture's own
 * entries and recorded beside R1.
 *
 * ELEVEN OF THE THIRTY ARE ALREADY R1 CASES, with identical `objects` and `brand` — so they are the
 * same call, and one reply is written into BOTH files rather than being bought twice. That is checked
 * rather than assumed: `sceneObjects` is keyed by sentence, and a shared sentence takes its objects
 * from here and from `CASES` identically or the recording would not describe either call correctly.
 *
 * Net cost of covering scene.json: NINETEEN extra calls, not thirty.
 */
const SCENE_OBJECTS: Record<string, number> = {
  "me on a beach": 0,
  "make me look like im at the beach": 0,
  "picture of me running on a track at sunset": 0,
  "make a pic of me training in the gym": 0,
  "generate pic of me playing soccer": 0,
  "put me mid-air dunking": 0,
  "me dunking in a stadium": 0,
  "a photo of me celebrating a goal in the rain": 0,
  "me holding a trophy on stage": 0,
  "me doing a bicycle kick in a packed stadium": 0,
  "me scoring a header in a cup final": 0,
  "a shot of me stretching before practice": 0,
  "change the scenery to a beach at sunset": 0,
  "change my shoes to adidas and the background to a stadium": 0,
  "switch my jersey over to adidas": 0,
  "make her jersey blue and give the socks some stripes": 0,
  "no nike logos anywhere please, and make my socks white": 0,
  "add a soccer ball between my cleats, keep everything else the same": 0,
  "add these gold hoops": 1,
  "give me these gold hoops": 1,
  "put a baseball cap on my head": 0,
  "make it pop": 0,
  "swap the ball for a basketball": 0,
  "add a soccer ball": 0,
  "take the logo off my sleeve": 0,
  "make the sky moodier": 0,
  "a picture of me surfing a big wave": 0,
  "me signing autographs after the game": 0,
  "me celebrating with my team in the locker room": 0,
  "a photo of me lifting weights": 0,
};

/** Which fixtures a sentence belongs in. A sentence in both is recorded once and written twice. */
function setsFor(sentence: string, inR1: boolean): ("r1" | "scene")[] {
  const out: ("r1" | "scene")[] = [];
  if (inR1) out.push("r1");
  if (sentence in SCENE_OBJECTS) out.push("scene");
  return out;
}

interface Case {
  sentence: string;
  /** Object photos attached. */
  objects?: number;
  /** The ad's brand, when the case is an ad (attached or named). */
  brand?: string;
  note: string;
}

const CASES: Case[] = [
  // The ad (acceptance 1a/1c and around it). The brand is what the ad gate would hand the interpreter.
  {
    sentence: "turn this into an adidas ad. dont change anything about me",
    brand: "adidas",
    note: "1a/1c",
  },
  {
    sentence: "turn this into an ad. dont change anything about me",
    brand: "adidas",
    note: "1a, brand attached",
  },
  { sentence: "make this an adidas ad", brand: "adidas", note: "ad" },
  {
    sentence: "turn this into a nike ad",
    brand: "nike",
    note: "ad on its own brand's kit",
  },
  {
    sentence:
      "can you turn this into an adidas campaign shot and keep me the same",
    brand: "adidas",
    note: "ad, polite",
  },
  {
    sentence: "turn this into an adidas ad and make it warmer",
    brand: "adidas",
    note: "ad + her look (M6)",
  },
  {
    sentence: "turn this into an adidas ad with the headline OWN THE MOMENT",
    brand: "adidas",
    note: "ad + her headline",
  },
  {
    sentence: "turn this into a puma ad but dont change my face",
    brand: "puma",
    note: "ad + keep",
  },
  {
    sentence: "make it look like a nike commercial",
    brand: "nike",
    note: "ad, commercial",
  },
  {
    sentence: "turn this into an ad",
    brand: "adidas",
    note: "ad, brand attached, no keep",
  },
  // Sentence 4 and around it.
  {
    sentence:
      "change my uniform so that its a black adidas uniform. i dont want any nike logos showing in this so if there are any remove them. also make my cleats pink and adidas",
    note: "acceptance 4",
  },
  {
    sentence:
      "change my uniform to black adidas and i dont want any nike logos anywhere",
    note: "4-ish",
  },
  { sentence: "make my cleats pink and adidas", note: "4's third clause" },
  {
    sentence: "change my uniform so that its a black adidas uniform",
    note: "4's first clause",
  },
  {
    sentence: "if there are any nike logos remove them",
    note: "exclusion alone",
  },
  {
    sentence: "no nike logos anywhere please, and make my socks white",
    note: "exclusion + recolour",
  },
  // The earrings (acceptance 3's interpreter phrasings), her hoops photo attached.
  { sentence: "give me these gold hoops", objects: 1, note: "acceptance 3" },
  {
    sentence: "i dont have earrings in this one, add these gold hoops",
    objects: 1,
    note: "acceptance 3",
  },
  {
    sentence: "add these gold hoops",
    objects: 1,
    note: "acceptance 3, no place",
  },
  {
    sentence: "can you give me these earrings",
    objects: 1,
    note: "worn, polite",
  },
  {
    sentence: "add small gold hoops to my ears",
    objects: 1,
    note: "worn_add_unclear",
  },
  { sentence: "put a baseball cap on my head", note: "worn_add_unclear" },
  {
    sentence: "i want these hoops in my ears please",
    objects: 1,
    note: "worn, wanting",
  },
  // Preservation.
  {
    sentence:
      "add a soccer ball between my cleats, keep everything else the same",
    note: "v1 §5",
  },
  { sentence: "make the socks blue and change nothing else", note: "v1 §5" },
  {
    sentence: "make my shorts black but keep me exactly the same",
    note: "keep",
  },
  // Headlines (#433's natural phrasings — they ask, and the interpreter renders the strict shape).
  { sentence: "add a banner that says GET LOUD", note: "headline" },
  { sentence: "put the text OWN IT across the top", note: "headline" },
  {
    sentence: "add the headline OWN THE MOMENT",
    note: "headline, no placement",
  },
  { sentence: 'add "RISE UP" at the top', note: "headline, quoted" },
  // The corpus's asks.
  { sentence: "change my red socks to nike", note: "brand_change" },
  { sentence: "change my jersey to adidas without stripes", note: "negation" },
  { sentence: "make my jersey a nike adidas kit", note: "two brands" },
  { sentence: "remove the 8 and nike logo", note: "brand_removal" },
  { sentence: "add a soccer ball", note: "no place" },
  {
    sentence: "make her jersey blue and give the socks some stripes",
    note: "compound_partial",
  },
  { sentence: "switch my jersey over to adidas", note: "brand_change" },
  {
    sentence: "change the scenery to a beach at sunset",
    note: "setting word off the list",
  },
  { sentence: "make it pop", note: "decline" },
  { sentence: "i want my jersey in adidas colours", note: "colours" },
  { sentence: "put my name on the back of my jersey", note: "design" },
  { sentence: "give me a nike swoosh on my shorts", note: "design" },
  {
    sentence: "turn my socks into adidas ones please and keep me the same",
    note: "brand + keep",
  },
  { sentence: "can you make the jersey look vintage", note: "look on a thing" },
  {
    sentence: "swap the ball for a basketball",
    note: "non-brand swap — off the menu",
  },
  {
    sentence: "change my shoes to adidas and the background to a stadium",
    note: "brand + background",
  },
];

// ─── The frame — READ ONLY ──────────────────────────────────────────────────────────────────────

async function frame(): Promise<{ bytes: Buffer; mimeType: string }> {
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { and, eq } = await import("drizzle-orm");
  // TENANCY: the athlete id is in the predicate, not checked after the fact.
  const [row] = await db
    .select({ path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.id, FRAME_ID), eq(mediaAssets.athlete_id, ATHLETE_ID)),
    )
    .limit(1);
  if (!row?.path)
    throw new Error(`No stored pixels for ${FRAME_ID} under this athlete`);
  const probe = await probeBytesFor(row.path);
  if (!probe) throw new Error("The frame could not be read");
  return probe;
}

// ─── The preflight (studio/interpret/preflight.ts — the walk is tested there) ────────────────────

type Sent = { text: string; usage: TransportUsage | null; ms: number };

/** One call with `params` exactly as given. Never throws: a refusal comes back as Vertex's WHOLE answer. */
async function send(params: WireRequest): Promise<SendResult<Sent>> {
  const started = Date.now();
  try {
    const res = await withTimeout(
      genai().models.generateContent(params as never),
      interpreterTimeoutMs(),
      "studio interpreter preflight",
    );
    const um = (res as { usageMetadata?: Record<string, number> })
      .usageMetadata;
    return {
      ok: true,
      value: {
        text: res.text ?? "",
        usage: um
          ? {
              inputTokens: um.promptTokenCount ?? 0,
              outputTokens:
                (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
            }
          : null,
        ms: Date.now() - started,
      },
    };
  } catch (err) {
    const e = err as { message?: string; status?: number };
    return {
      ok: false,
      error: `${e.status ? `HTTP ${e.status} — ` : ""}${e.message ?? String(err)}`,
    };
  }
}

/**
 * Print the wire beside detection's, send the product's exact request once, and — if Vertex refuses it —
 * name the field. Returns the accepted answer, or null (and nothing else is sent) when it was refused.
 */
async function checkWire(
  input: Parameters<typeof interpreterPrompt>[0],
  image: { bytes: Buffer; mimeType: string },
): Promise<Sent | null> {
  const product = interpreterRequest({
    prompt: interpreterPrompt(input),
    image,
  });
  // models.ts's own defaults, restated for this print only (it does not export them).
  const project = process.env.GCP_PROJECT_ID ?? "gamechanger-pocket-agent";
  const location = process.env.VERTEX_LOCATION ?? "global";
  console.log(
    "PREFLIGHT — the wire, beside the request detection and QA send daily:",
  );
  console.log(
    `  project/location   ${project} / ${location}   (the shared genai() client, both)`,
  );
  for (const line of wireLines(product, GEMINI.flash)) console.log(`  ${line}`);
  console.log(
    "  contents           [inlineData image/jpeg, text] — detection's own order",
  );
  const r = await preflight(product, GEMINI.flash, send);
  if (r.kind === "accepted") {
    console.log(
      `PREFLIGHT OK — Vertex accepts the product request (${r.value.ms}ms).`,
    );
    return r.value;
  }
  console.log(
    `PREFLIGHT REFUSED — the product request. Vertex's whole answer:\n  ${r.error}`,
  );
  for (const t of r.tried)
    console.log(`  without ${t.field}: still refused — ${t.error}`);
  if (r.kind === "named") {
    console.log(
      `  → THE FAILING FIELD IS ${r.field}: without it, Vertex accepts the request.`,
    );
  } else {
    console.log(
      "  → Detection's own request shape is refused too, so the difference is not in the config: check the " +
        "model id, the project's quota and the frame bytes.",
    );
  }
  console.log(`  ${r.calls} calls made. Nothing else is sent.`);
  return null;
}

/**
 * Her sport and level, exactly as `routes/studio.ts` reads them — the no-brand fork's register.
 *
 * TENANCY: keyed on ATHLETE_ID, which is Adi's own athlete row and the same id this script already
 * reads the frame under. Read-only.
 */
async function athleteRegisterFor(
  athleteId: string,
): Promise<AthleteRegister | null> {
  const [row] = await db
    .select({ sport: athletes.sport })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  if (!row) return null;
  return row.sport === null ? null : { sport: row.sport };
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // R1's cases, then the scene sentences R1 does not already cover. Eleven overlap with identical
  // objects and brand, so they are ONE call whose reply is written into both fixtures.
  const inR1 = new Set(CASES.map((c) => c.sentence));
  const sceneOnly: Case[] = Object.keys(SCENE_OBJECTS)
    .filter((sentence) => !inR1.has(sentence))
    .map((sentence) => ({
      sentence,
      objects: SCENE_OBJECTS[sentence],
      note: "scene",
    }));
  const all = [...CASES, ...sceneOnly];
  const cases = ONLY ? all.slice(0, ONLY) : all;

  // ─── WHAT PRODUCTION SENDS, NOT A SIMPLIFIED VERSION OF IT (wave C card 3) ────────────────────
  //
  // The ad's treatment used to be built here with name and category alone, which is what the request
  // path sent until card 3. It now carries the brand's own look and tone off its inbox_brands row, and
  // her register when the brand has NO row — so a recording made without them would be a recording of
  // a prompt the product no longer builds, and every ad cell would replay the old shape.
  //
  // Both are read the same way the request path reads them: the brand's row through the same lookup
  // `forPreview` uses, and her sport and level under HER athlete id. Read-only, and both may be null —
  // a brand with no row is a real production case (fork A), not a failure here.
  const register = RUN ? await athleteRegisterFor(ATHLETE_ID) : null;
  const profiles = new Map<
    string,
    Awaited<ReturnType<typeof getBrandContext>>
  >();
  for (const brand of new Set(
    CASES.flatMap((c) => (c.brand ? [c.brand] : [])),
  )) {
    const id = RUN ? await brandIdForName(brand) : null;
    profiles.set(brand, id === null ? null : await getBrandContext(id));
  }
  const treatmentOf = (brand: string, sentence: string) => {
    const row = profiles.get(brand) ?? null;
    return adTreatment(
      brand,
      row?.category ?? "Athletic Apparel",
      row ?? undefined,
      row ? undefined : { register, sentence },
    );
  };
  const inputs = cases.map((c) => {
    const t = c.brand ? treatmentOf(c.brand, c.sentence) : null;
    return {
      c,
      input: recordedInput(c.sentence, {
        attached: { objects: c.objects ?? 0 },
        brand: c.brand ?? null,
        menu: MENU,
        swapTo: t?.swapTo ?? null,
        competitors: t?.competitors ?? [],
        category: t?.category ?? null,
        profile: t?.profile ?? null,
        register: t?.register ?? null,
      }),
      today: route(c.sentence, true, { objects: c.objects ?? 0 }),
    };
  });
  // ─── WHY A SCENE SENTENCE IS SENT EVEN WHEN THE RULES NOW CLAIM IT ───────────────────────────
  //
  // R1's filter is right for R1: a sentence the rules route never reaches the interpreter in
  // production, so recording one would describe a call the product never makes.
  //
  // The SCENE fixture is the opposite case. `scene.test.ts` pins all thirty and its CLAIMED_BY_RULES
  // map exists precisely to say "a rule reads this one now, and here is what the interpreter made of
  // it anyway" — four sentences are already in that map (wave A's V2, V3 and V4). Dropping them would
  // fail its "none added, none lost" assertion, and carrying the OLD replies forward would put
  // interpret/5 answers inside a file stamped interpret/6, which is the exact dishonesty the version
  // gate exists to prevent. So they are re-sent: four extra calls, and every reply in the file is a
  // real answer to the prompt the file claims.
  const isScene = (sentence: string) => sentence in SCENE_OBJECTS;
  const sendable = inputs.filter(
    ({ c, today }) =>
      (today.initialPath === "ASK" && interpretableAsk(today.reason)) ||
      isScene(c.sentence),
  );

  console.log(
    `R1 + SCENE — ${PROMPT_VERSION}, ${interpreterModel()}, menu text=${MENU.text} exclusion=${MENU.exclusion} ` +
      `(STUDIO_DISPLAY_TEXT=${displayTextEnabled() ? "true" : "off"}, set to match the menu). ` +
      `${sendable.length} of ${inputs.length} sentences are eligible asks today. ` +
      `Quote ~$${(sendable.length * QUOTE_PER_CALL_USD).toFixed(3)}, cap $${CAP_USD}. ${RUN ? "LIVE." : "DRY RUN — no call, no row read."}`,
  );
  for (const { c, input, today } of inputs) {
    const fate =
      today.initialPath !== "ASK"
        ? isScene(c.sentence)
          ? `routes today (${today.steps[0]?.op ?? "?"}) — sent anyway, scene pins it`
          : "routes today — never sent"
        : interpretableAsk(today.reason)
          ? `asks ${today.reason} — sent`
          : isScene(c.sentence)
            ? `asks ${today.reason} — sent anyway (scene pins it)`
            : `asks ${today.reason} — never eligible, not sent`;
    console.log(
      `  ${c.sentence.slice(0, 70).padEnd(70)} ${fate}  [${c.note}${c.brand ? `, ${c.brand} ad` : ""}${c.objects ? ", 1 object photo" : ""}] prompt ${interpreterPrompt(input).length} chars`,
    );
  }
  if (!RUN) return;

  const image = await frame();
  const entries: RecordedReply[] = [];
  let spent = 0;
  const [head, ...rest] = sendable;
  if (!head) return;
  const pre = await checkWire(head.input, image);
  if (!pre) return;
  const record = (
    c: Case,
    text: string,
    usage: TransportUsage | null,
    ms: number,
  ) => {
    entries.push({
      sentence: c.sentence,
      objects: c.objects ?? 0,
      brand: c.brand ?? null,
      text,
      usage,
      ms,
    });
  };
  const report = (
    c: Case,
    input: (typeof sendable)[number]["input"],
    text: string,
    usage: TransportUsage | null,
    ms: number,
  ) => {
    const out = propose(input, text, adPlan);
    console.log(
      `  ${String(ms).padStart(5)}ms ${usage ? `${usage.inputTokens}in/${usage.outputTokens}out` : "no usage"}  ` +
        `${out.kind === "proposal" ? `PROPOSAL  ${out.canonical}` : out.kind === "new_image" ? "NEW IMAGE" : `ASK ${out.outcome}${out.askReason ? ` (${out.askReason})` : ""}`}  ← ${c.sentence}`,
    );
  };
  spent += pre.usage
    ? pre.usage.inputTokens * 0.3e-6 + pre.usage.outputTokens * 2.5e-6
    : QUOTE_PER_CALL_USD;
  record(head.c, pre.text, pre.usage, pre.ms);
  report(head.c, head.input, pre.text, pre.usage, pre.ms);
  for (const { c, input } of rest) {
    if (spent + QUOTE_PER_CALL_USD > CAP_USD) {
      console.log(
        `BUDGET STOP before "${c.sentence}": ~$${spent.toFixed(4)} estimated, cap $${CAP_USD}.`,
      );
      break;
    }
    const started = Date.now();
    let text: string;
    let usage: RecordedReply["usage"];
    try {
      const r = await geminiTransport({
        prompt: interpreterPrompt(input),
        image,
      });
      text = r.text;
      usage = r.usage;
    } catch (err) {
      // Vertex's WHOLE answer — the field that failed is in it, and a cut message is how that got lost.
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  CALL FAILED on "${c.sentence}": ${message}`);
      continue;
    }
    const ms = Date.now() - started;
    const est = usage
      ? usage.inputTokens * 0.3e-6 + usage.outputTokens * 2.5e-6
      : QUOTE_PER_CALL_USD;
    spent += est;
    record(c, text, usage, ms);
    report(c, input, text, usage, ms);
  }

  // ONE RUN, TWO FIXTURES. A sentence in both sets is written to both files from the single reply it
  // produced — identical objects and brand, so it is literally the same call.
  const recordedAt = new Date().toISOString();
  const write = async (path: string, set: "r1" | "scene") => {
    const mine = entries.filter((e) =>
      setsFor(e.sentence, inR1.has(e.sentence)).includes(set),
    );
    // ⚠️ THE SCENE FIXTURE'S ORDER IS PINNED AND IT MEANS SOMETHING — scene.test.ts's "none added,
    // none lost" compares the entry list in order, and that order is the probe's four sets (A must-flip,
    // B controls, C catch-alls, D held out). Recording order is not that order: the eleven sentences
    // shared with R1 are sent first, as R1 cases, so they would all bunch at the top. So the scene file
    // is written in SCENE_OBJECTS' own order, which was rebuilt from the fixture itself.
    if (set === "scene") {
      const rank = new Map(Object.keys(SCENE_OBJECTS).map((k, i) => [k, i]));
      mine.sort(
        (a, b) => (rank.get(a.sentence) ?? 0) - (rank.get(b.sentence) ?? 0),
      );
    }
    const recording: Recording = {
      promptVersion: PROMPT_VERSION,
      model: interpreterModel(),
      menu: MENU,
      recordedAt,
      entries: mine,
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(recording, null, 2)}\n`, "utf8");
    console.log(`  ${String(mine.length).padStart(3)} replies → ${path}`);
  };
  console.log(
    `Recorded ${entries.length} replies. Estimated spend ~$${spent.toFixed(4)}.`,
  );
  await write(OUT, "r1");
  await write(OUT_SCENE, "scene");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
