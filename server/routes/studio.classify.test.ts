/**
 * studio.classify.test.ts — the routing cutover, over real HTTP.
 *
 * ─── WHAT THIS SUITE IS FOR ────────────────────────────────────────────────────────────────────
 *
 * `classify.test.ts` already pins the classifier itself, exhaustively, as a pure function. Nothing
 * here re-tests that. This suite exists for the things a pure-function test cannot see — everything
 * that happens between `route()` returning an answer and a client being able to act on it:
 *
 *   1. THE REASON SURVIVES THE ROUND TRIP. `person_target` and `fast_path_declined` must arrive as
 *      DISTINCT strings. They are both ASK and they want different UI — one is a refusal that no
 *      rephrasing changes, the other is a question that rephrasing answers. The classifier does the
 *      work of telling them apart, and every layer between it and the screen is a place that work
 *      can be flattened into a generic decline. This is the assertion that would rot silently.
 *   2. "MAKE THE SOCKS BLUE" NEVER REACHES GENERATE, end to end rather than at the enum. The
 *      sentence goes through the real classify route, the answer picks the intent the way the
 *      client picks it, and that intent goes through the real preview route — and the brief that
 *      comes back out the far side is an EDIT. That is the bug this whole cutover exists to close.
 *   3. `steps` travels as a LIST beside the flattened `op`/`targets`, rather than instead of it.
 *      Multi-step answers are not producible from the fast path today — every branch of
 *      `classifyFast` returns exactly one — so what is pinned is the wire's shape, not a second
 *      step that does not exist yet. See the note on that test.
 *
 * ─── WHY THE PREVIEW LEG RUNS HERE AND NOT AGAINST THE REAL SERVER ─────────────────────────────
 *
 * The chain this proves ends in a written preview row and, on the derivation path, a Gemini call.
 * Against the live server that is a row in shared Cloud SQL and real model spend for a test. Here
 * the router is REAL, the HTTP is real, the SQL is real (PGlite), and only the model boundary and
 * the object store are mocked — which is the same trade every other route suite in this directory
 * makes, and the reason `roots` includes `server/` alone.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../lib/models", () => ({
  genai: () => ({}),
  GEMINI: {
    pro: "test-pro",
    flash: "test-flash",
    flashLite: "test-flash-lite",
  },
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
}));
/**
 * THE MODEL BOUNDARY, MOCKED — and it is the only mock in this file that changes what the route
 * DOES rather than what it talks to.
 *
 * `resolveSource` derives a region from her sentence when she drew none, which is a real Gemini
 * call. The first check out of Create anything always takes that branch (there is no mask editor on
 * that screen), so the socks case below cannot avoid it by passing regions — passing regions would
 * be testing the path where she HAS drawn a box, which is the one path this cutover does not
 * change. So the detector answers synthetically and the rest of the route runs for real.
 */
jest.mock("../studio/autoMask", () => ({
  probeBytesFor: jest.fn(async () => ({
    bytes: Buffer.from("jpeg"),
    mimeType: "image/jpeg",
  })),
  detectRegionsMemoized: jest.fn(async () => ({
    ok: true,
    regions: [
      { label: "the socks", left: 0.4, top: 0.7, width: 0.2, height: 0.2 },
    ],
  })),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter from "./studio";
import { athletes, athletesCurrent, mediaAssets } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;

const asUser = (id: string) => {
  (globalThis as any).__TEST_ATHLETE_ID = id;
};

async function seedScoredAthlete(name: string): Promise<string> {
  const id = await seedAthlete(name);
  await db
    .update(athletes)
    .set({ sport: "Soccer", school: "Test University", division: "D1" } as any)
    .where(eq(athletes.id, id));
  await db.insert(athletesCurrent).values({
    athlete_id: id,
    story_arc: "A synthetic arc for tests.",
  } as any);
  return id;
}

/** A stored frame of hers, with dimensions the size probe can read. */
async function seedFrame(owner: string): Promise<string> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "instagram",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${owner}/frame-${Math.random().toString(36).slice(2)}.jpg`,
      approval_status: "draft",
    } as any)
    .returning({ id: mediaAssets.id, path: mediaAssets.gcs_path });
  FRAMES.add(row.path!);
  return row.id;
}

// The frame probe, served synthetically — same shape as studio.test.ts, and for the same reason:
// the route signs, ranges, parses and multiplies for itself, and only the bytes are ours.
const FRAMES = new Set<string>();
const realFetch = globalThis.fetch;

function jpegBytes(width: number, height: number): Buffer {
  const sof = Buffer.alloc(10);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.from([0xff, 0xda]),
  ]);
}

beforeAll(async () => {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url =
      typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.startsWith("https://signed.example/")) {
      const path = decodeURIComponent(
        url.slice("https://signed.example/".length),
      );
      if (!FRAMES.has(path)) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(jpegBytes(4000, 6000)), {
        status: 206,
      });
    }
    return realFetch(input, init);
  };

  process.env.STUDIO_ENABLED = "true";
  await initTestDb();

  athleteId = await seedScoredAthlete("Test Athlete");
  asUser(athleteId);

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", studioRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});

afterAll(async () => {
  (globalThis as any).fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});

beforeEach(() => {
  process.env.STUDIO_ENABLED = "true";
  delete process.env.STUDIO_SERVER_ROUTING;
  asUser(athleteId);
});

const classify = (body: unknown) =>
  fetch(`${base}/studio/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Her sentence, with a photograph of hers in the request. The case the cutover is named for. */
const withPhoto = (direction: string) =>
  classify({ direction, hasSourcePhoto: true });

// ─── The gate ───────────────────────────────────────────────────────────────────────────────────

describe("the flag and the gate", () => {
  it("404s when STUDIO_ENABLED is off — it is the same door as every other studio route", async () => {
    process.env.STUDIO_ENABLED = "false";
    expect((await withPhoto("remove the ball")).status).toBe(404);
  });

  it("is read at call time, so flipping it needs no restart", async () => {
    process.env.STUDIO_ENABLED = "false";
    expect((await withPhoto("remove the ball")).status).toBe(404);
    process.env.STUDIO_ENABLED = "true";
    expect((await withPhoto("remove the ball")).status).toBe(200);
  });
});

// ─── The body ───────────────────────────────────────────────────────────────────────────────────

describe("the request shape", () => {
  it("refuses a missing or empty direction rather than classifying nothing", async () => {
    expect((await classify({ hasSourcePhoto: true })).status).toBe(400);
    expect(
      (await classify({ direction: "   ", hasSourcePhoto: true })).status,
    ).toBe(400);
  });

  it("REQUIRES hasSourcePhoto rather than defaulting it", async () => {
    // A default here would be a default for the guard. The safe value (`true`) silently withholds
    // GENERATE from every net-new request that forgot the field, so a caller gets told instead.
    const res = await classify({ direction: "remove the ball" });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("hasSourcePhoto");
  });

  it("takes a purpose from Create anything's composer — draft or shape — and answers exactly as without one (auto-mark)", async () => {
    for (const direction of [
      "make the socks blue",
      "make me taller",
      "generate pic of me playing soccer",
    ]) {
      const plain = await (await withPhoto(direction)).json();
      for (const purpose of ["draft", "shape"]) {
        const res = await classify({
          direction,
          hasSourcePhoto: true,
          purpose,
        });
        expect({ direction, purpose, status: res.status }).toEqual({
          direction,
          purpose,
          status: 200,
        });
        expect({ direction, purpose, body: await res.json() }).toEqual({
          direction,
          purpose,
          body: plain,
        });
      }
    }
  });

  it("refuses a purpose that is not draft or shape, rather than logging it as a sentence she was shown", async () => {
    for (const purpose of ["plan", "", 1, null, ["draft"]]) {
      const res = await classify({
        direction: "make me taller",
        hasSourcePhoto: true,
        purpose,
      });
      expect({ purpose, status: res.status }).toEqual({ purpose, status: 400 });
      expect((await res.json()).field).toBe("purpose");
    }
  });

  it("bounds the sentence instead of handing an unbounded body to a dozen regexes", async () => {
    const res = await classify({
      direction: "a".repeat(2001),
      hasSourcePhoto: true,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("direction");
  });
});

// ─── THE REASON, WHICH IS THE WHOLE POINT OF THE FIELD ──────────────────────────────────────────

describe("the reason survives the round trip", () => {
  /**
   * ⚠️ THE ASSERTION THIS SUITE EXISTS FOR.
   *
   * Both of these are ASK. Both stop the request. A layer that collapsed them into one decline
   * would pass every other test in this file and every test in classify.test.ts — the classifier
   * would still be right, and the screen would still be wrong, because it would tell a woman whose
   * sentence was refused to go and rephrase it.
   *
   * So they are asserted as DISTINCT rather than as two independently-correct constants: the thing
   * that must hold is that they can still be told apart at the far end of the wire.
   */
  it("keeps person_target and fast_path_declined DISTINCT over the wire", async () => {
    const person = await (await withPhoto("make my hair red")).json();
    const declined = await (
      await withPhoto("do something cool with this")
    ).json();

    expect(person.initialPath).toBe("ASK");
    expect(declined.initialPath).toBe("ASK");

    expect(person.reason).toBe("person_target");
    expect(declined.reason).toBe("fast_path_declined");
    expect(person.reason).not.toBe(declined.reason);
  });

  it("carries C.4's three decline codes over the wire, each distinct from the catch-all", async () => {
    // The G checks' three sentences, which all arrived as fast_path_declined before PR C′. The brand
    // one, "change my jersey to adidas", routes since 2026-09-10 (rule 4c) — and so do a brand change
    // with a descriptor and (B.1c) one naming a model — so a colour inside an item, which 4c still
    // declines, stands in for it.
    const body = await (await withPhoto("make my arms bigger")).json();
    const brand = await (await withPhoto("change my red socks to nike")).json();
    const add = await (await withPhoto("add a soccer ball")).json();

    expect([body.reason, brand.reason, add.reason]).toEqual([
      "person_mentioned",
      "brand_change",
      "add_unclear",
    ]);
    for (const r of [body, brand, add]) expect(r.initialPath).toBe("ASK");
  });

  it("carries a composed sentence over the wire as every step, with no reason — B-p5, which compiled 'remove the jersey' on main", async () => {
    // Composition (classify.ts, rule ½). PR 1 sent both as ASK / compound_pending; and F2: B-c7 was
    // the person refusal on main, for a sentence that edits no one. `op` and `targets` are the first
    // step's, as for any multi-step answer; `steps` carries the rest.
    const bp5 = await (
      await withPhoto("Remove the soccer ball, and make her jersey blue.")
    ).json();
    const bc7 = await (
      await withPhoto("add a soccer ball at her feet and make her jersey blue")
    ).json();
    expect(bp5).toMatchObject({
      initialPath: "FULL_IMAGE",
      op: "RECOLOR",
      targets: ["jersey"],
    });
    expect(bp5.steps.map((s: { op: string }) => s.op)).toEqual([
      "RECOLOR",
      "REMOVE_OBJECT",
    ]);
    expect(bc7).toMatchObject({ initialPath: "FULL_IMAGE", op: "ADD_OBJECT" });
    expect(bc7.steps.map((s: { op: string }) => s.op)).toEqual([
      "ADD_OBJECT",
      "RECOLOR",
    ]);
    for (const r of [bp5, bc7]) expect(r.reason).toBeUndefined();
  });

  it("carries no reason at all on an answer that routes — absence is the signal", async () => {
    const body = await (await withPhoto("remove the ball")).json();
    expect(body.initialPath).toBe("MASKED");
    expect(body.reason).toBeUndefined();
  });

  it("never echoes her sentence back inside the reason", async () => {
    // The reason is a CODE. A reason that quoted the instruction would put untrusted text — a
    // direction can arrive from an inbox message — into whatever renders or logs it downstream.
    const body = await (await withPhoto("make my hair red")).json();
    expect(body.reason).toBe("person_target");
    expect(JSON.stringify(body)).not.toContain("hair");
  });
});

// ─── The shape of a routed answer ───────────────────────────────────────────────────────────────

describe("the wire shape", () => {
  it("flattens the first step onto op/targets AND sends steps whole", async () => {
    const body = await (await withPhoto("remove the ball")).json();
    expect(body.op).toBe("REMOVE_OBJECT");
    expect(body.targets).toEqual(["ball"]);
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].op).toBe("REMOVE_OBJECT");
  });

  /**
   * ⚠️ MULTI-STEP IS NOT REACHABLE FROM HERE TODAY, AND THIS TEST SAYS SO RATHER THAN FAKING IT.
   *
   * `classifyFast` returns `one(...)` at every branch, so no sentence produces two steps over this
   * route — "make my jersey a blue adidas kit" declines (rule 4b) precisely because splitting it
   * needs a stage that does not exist yet. The multi-step SHAPE is real and is exercised against
   * `orderSteps`/`validate` directly in classify.test.ts.
   *
   * So what is pinned here is the property the wire actually has to keep: `steps` travels as a LIST
   * beside the flattened pair, and `op`/`targets` are read off its first entry rather than being a
   * separate answer. A response that dropped `steps` would pass every other test in this file and
   * would silently truncate the day a second step becomes producible.
   *
   * ⚠️ 2026-09-10: THAT DAY IS HERE. Rule 4c makes a brand change one step per item, so "change my
   * uniform, socks, and shoes all to be adidas" is three steps over this route — pinned by the next
   * test but one. The blue adidas kit is ONE step: a REPLACE whose value carries the colour.
   */
  it("sends steps as a list beside the flattened pair, not instead of it", async () => {
    const body = await (await withPhoto("remove the ball")).json();
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.op).toBe(body.steps[0].op);
    expect(body.targets).toEqual(body.steps[0].targets);
    // The whole step, not just the two fields hoisted out of it.
    expect(body.steps[0]).toMatchObject({
      op: "REMOVE_OBJECT",
      targets: ["ball"],
      value: null,
      scope: "REGION",
    });
  });

  it("carries a multi-item brand change WHOLE — every item's step, not just the flattened first", async () => {
    const body = await (
      await withPhoto("change my uniform, socks, and shoes all to be adidas")
    ).json();
    expect(body.initialPath).toBe("MASKED");
    expect(body.op).toBe("REPLACE_OBJECT");
    expect(body.targets).toEqual(["uniform"]);
    expect(
      body.steps.map((s: { targets: string[]; value: string }) => [
        s.targets,
        s.value,
      ]),
    ).toEqual([
      [["uniform"], "adidas uniform"],
      [["socks"], "adidas socks"],
      [["shoes"], "adidas shoes"],
    ]);
  });

  /**
   * K8 (ADI-R19 R-19): `confidence` and `ambiguity` were deleted as one unit with validate's floors and the
   * low_confidence asks — the fast path always said 1 / null, and `route` calls no model that could ever say
   * otherwise. ⚠️ MUTATION M-K8: put `confidence` back on a routed answer — this reds by name.
   */
  it("carries no confidence and no ambiguity, routed or asked (K8: deleted as one unit)", async () => {
    const routed = await (await withPhoto("remove the ball")).json();
    const declined = await (
      await withPhoto("do something cool with this")
    ).json();
    for (const body of [routed, declined]) {
      expect(body).not.toHaveProperty("confidence");
      expect(body).not.toHaveProperty("ambiguity");
    }
    expect(routed.initialPath).not.toBe("ASK");
    expect(declined.initialPath).toBe("ASK");
  });

  it("op is null and targets empty on an ASK, rather than a partial step", async () => {
    const body = await (await withPhoto("do something cool with this")).json();
    expect(body.op).toBeNull();
    expect(body.targets).toEqual([]);
    expect(body.steps).toEqual([]);
  });
});

// ─── THE BUG THIS CUTOVER EXISTS TO CLOSE ───────────────────────────────────────────────────────

describe('"make the socks blue" never reaches GENERATE', () => {
  it("classifies as a RECOLOR of the socks, not a new image", async () => {
    const body = await (await withPhoto("make the socks blue")).json();
    expect(body.op).toBe("RECOLOR");
    expect(body.initialPath).toBe("FULL_IMAGE");
    expect(body.initialPath).not.toBe("GENERATE");
    expect(body.targets).toEqual(["socks"]);
  });

  it("withholds GENERATE from the sentence even though 'make' heads it", async () => {
    // "make" heads both "make the socks blue" and "make me a new poster". The verb is not the
    // discriminator — the INDEFINITE is — which is the whole reason the verb list had to go.
    const edit = await (await withPhoto("make the socks blue")).json();
    const generate = await (
      await withPhoto("make me a new poster for the game")
    ).json();
    expect(edit.initialPath).toBe("FULL_IMAGE");
    expect(generate.initialPath).toBe("GENERATE");
  });

  /**
   * ⚠️ THE END-TO-END ONE, AND THE REASON IT IS NOT AN ENUM ASSERTION.
   *
   * Everything above proves the classifier answers correctly over HTTP. None of it proves the
   * answer changes what the engine is asked to do — and the old bug lived entirely in that gap:
   * `editBaseFor` returned null, `engineIntentFor` fell through to `image.generate`, and the frame
   * was replaced by a route that was working exactly as written.
   *
   * So this walks the whole chain the client walks. The classify route picks the intent, the way
   * `routeWithServer` picks it (FULL_IMAGE is an edit path ⇒ image.edit, base = her source frame),
   * and that intent goes through the REAL preview route. The assertion is on the brief that comes
   * back out the far side: `mode: "edit"`, with her photograph as the source. Not a path, not an
   * op — the thing the engine would actually have done to her picture.
   */
  it("survives the crossing into the preview: the brief is an EDIT, on her frame", async () => {
    const frameId = await seedFrame(athleteId);

    const routed = await (await withPhoto("make the socks blue")).json();

    const EDIT_PATHS = ["FULL_IMAGE", "MASKED", "BACKGROUND"];
    const intent = EDIT_PATHS.includes(routed.initialPath)
      ? "image.edit"
      : "image.generate";
    expect(intent).toBe("image.edit");

    const res = await fetch(`${base}/studio/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent,
        deliverable: "post",
        objective: "grow-following",
        direction: "make the socks blue",
        // The client sends the base and NO regions on the first check — there is no mask editor on
        // Create anything, so the server derives the box from her sentence.
        sourceAssetId: frameId,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // THE ASSERTION. Pre-cutover this brief said "generate" and her photograph was the anchor for a
    // new picture rather than the subject of an edit.
    expect(body.brief.job.mode).toBe("edit");
    expect(body.brief.job.mode).not.toBe("generate");
    expect(body.brief.job.source.mediaAssetId).toBe(frameId);
  });

  it("and the pre-cutover path is what it would have done instead — the bug, pinned", async () => {
    // Not a test of our code: a test of the VERB LIST, so the thing being fixed is on the record in
    // the same file as the fix. NAMES_AN_EDIT has no "make", so this sentence carried no edit verb,
    // `editBaseFor` returned null, and the intent fell through to a generate — which the preview
    // route would then build as `mode: "generate"`, replacing the frame.
    const NAMES_AN_EDIT =
      /\b(remove|delete|erase|get rid of|replace|swap|change|recolou?r|blur|retouch|clean up|cover up|edit)\b/i;
    const NAMES_AN_EDIT_SPLIT =
      /\b(take|cut|crop|rub|paint|wipe)\s+(?!me\b|myself\b)[^.?!]{0,30}\b(out|off)\b/i;

    const sentence = "make the socks blue";
    expect(NAMES_AN_EDIT.test(sentence)).toBe(false);
    expect(NAMES_AN_EDIT_SPLIT.test(sentence)).toBe(false);

    // And the server now says otherwise about the same words.
    const routed = await (await withPhoto(sentence)).json();
    expect(routed.initialPath).toBe("FULL_IMAGE");
  });
});

// ─── The hole this cutover does NOT close ───────────────────────────────────────────────────────

describe("hasSourcePhoto is the client's answer, and the server cannot check it", () => {
  /**
   * PINNED AS A KNOWN LIMIT RATHER THAN LEFT TO BE DISCOVERED.
   *
   * A caller that says `hasSourcePhoto: false` gets GENERATE for a sentence that plainly edits. The
   * server cannot catch this: whether a `role: "person"` reference is the frame being changed or an
   * identity anchor for a net-new image is a fact about which tray tile she filled, and the tray is
   * not on the wire. Deciding it here would break "put me on a rooftop at dusk" — a legitimate
   * generate with her photograph attached — which is the documented `source-frame` collision and
   * Mia's ref-role decision to make.
   *
   * The exposure is bounded: this is exactly the pre-cutover behaviour, so a lying client is no
   * worse off than every client was before the flag existed. This test exists so that the day
   * somebody closes the collision, a failing assertion tells them this was known and where.
   *
   * ⚠️ STILL A KNOWN LIMIT AFTER PR R, AND THE REASON IS NARROWER NOW. The tray has an answer to
   * give (the frame is her explicit mark, and material has an `object` tile of its own), but it
   * gives it on the CLIENT — `hasSourcePhoto` is still the only thing crossing the wire, and this
   * route still must not read the collision off the reference list. What PR R changed is which
   * photograph the client names, not whether the server may guess. It still may not.
   */
  it("returns GENERATE for an edit sentence when the caller claims no photo", async () => {
    const body = await (
      await classify({
        direction: "make the socks blue",
        hasSourcePhoto: false,
      })
    ).json();
    expect(body.initialPath).toBe("GENERATE");
  });
});

// ─── R.4 — generate-with-reference: the line, and both sides of it ──────────────────────────────

/**
 * THE RULE, AS THE MEMO'S OPEN QUESTION PHRASED IT.
 *
 * Sweep 7.4 asked it out loud: "with a photo attached, should 'create an adidas ad featuring me'
 * generate at all, or should it use that photo? The gate currently treats any attached photo as
 * 'you are editing'. A brand ad built from a reference is a legitimate generate-with-reference —
 * which is the ref-role decision again."
 *
 * It is answered, and it is one line either way:
 *
 *   EXPLICIT generate construction + a photo  →  GENERATE, with the photo as her identity.
 *   NO generate construction      + a photo  →  an EDIT of that photo.
 *
 * The construction is the whole discriminator — a creation verb, an INDEFINITE article, and an
 * artifact noun (EXPLICIT_GENERATE, studio/classify.ts). B′ widened the noun list so `ad` is one of
 * them; these pin the behaviour that widening produced, on both sides, so the line cannot drift
 * back without a red test. Nothing here changes the gate.
 */
describe("R.4 — generate with a reference, versus editing the reference", () => {
  const path = async (direction: string, hasSourcePhoto = true) =>
    (await (await classify({ direction, hasSourcePhoto })).json()).initialPath;

  it("GENERATES for the memo's own open-question sentence, with her photo attached", async () => {
    expect(await path("create an adidas ad featuring me")).toBe("GENERATE");
  });

  it("generates for the rest of the constructions a person actually types", async () => {
    expect(await path("make me a new poster for the last game")).toBe(
      "GENERATE",
    );
    expect(await path("create a new campaign image")).toBe("GENERATE");
    expect(await path("design an ad for adidas")).toBe("GENERATE");
    // "photograph" as "photo" (the preservation fixes, D3): Adi's live acceptance sentence, her photo attached.
    expect(await path("generate a professional sports photograph of her")).toBe(
      "GENERATE",
    );
  });

  it("EDITS the attached photo when there is no generate construction", async () => {
    // The other side of the line, and the expensive side to get wrong: a generate here replaces
    // the photograph. None of these carries a creation verb with an indefinite and a noun.
    for (const sentence of [
      "put me on a rooftop at dusk",
      "make the socks yellow",
      "remove the ball",
      "change the background to a beach",
    ]) {
      expect(await path(sentence)).not.toBe("GENERATE");
    }
  });

  it("stays an EDIT when the noun is there but the article is definite", async () => {
    // "make THE post brighter" names something that already exists; "make A post" does not. The
    // indefinite is the discriminator, and widening the noun list did not touch it.
    expect(await path("make the poster brighter")).not.toBe("GENERATE");
    expect(await path("make the ad darker")).not.toBe("GENERATE");
  });

  it("withholds GENERATE from an edit sentence even though the noun list is wide", async () => {
    // The guard is `hasSourcePhoto`, not the text: the regex only ever ADDS GENERATE back to a set
    // that already excludes it. A widened noun list must not become a way back in.
    expect(await path("add a logo to the banner")).not.toBe("GENERATE");
  });
});

describe("objectPhotos — how many Object photos are attached, and the side a missing count errs to (replace with reference)", () => {
  const FOUNDER = "change my earrings to these gold hoops";

  it("routes her sentence as ONE replacement pointing at her photo when the tray has one", async () => {
    const res = await classify({
      direction: FOUNDER,
      hasSourcePhoto: true,
      objectPhotos: 1,
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.reason).toBeUndefined();
    expect(json.steps).toEqual([
      {
        op: "REPLACE_OBJECT",
        targets: ["earrings"],
        value: "gold hoops",
        scope: "REGION",
        reference: "object",
      },
    ]);
  });

  it("ASKS for the photo when the tray has none — and when a client says nothing, which is the same answer", async () => {
    for (const body of [
      { direction: FOUNDER, hasSourcePhoto: true, objectPhotos: 0 },
      { direction: FOUNDER, hasSourcePhoto: true },
    ]) {
      const json = await (await classify(body)).json();
      expect({ initialPath: json.initialPath, reason: json.reason }).toEqual({
        initialPath: "ASK",
        reason: "object_photo_missing",
      });
    }
  });

  it("refuses a count that is not a count", async () => {
    for (const objectPhotos of [-1, 1.5, "1", null, 999]) {
      const res = await classify({
        direction: FOUNDER,
        hasSourcePhoto: true,
        objectPhotos,
      });
      expect({ objectPhotos, status: res.status }).toEqual({
        objectPhotos,
        status: 400,
      });
      expect((await res.json()).field).toBe("objectPhotos");
    }
  });

  it("changes nothing for a sentence that does not point — the same answer, count or no count", async () => {
    for (const direction of [
      "make my earrings gold",
      "change my earrings to gold hoops",
      "add a soccer ball between my cleats",
    ]) {
      const without = await (await withPhoto(direction)).json();
      const withOne = await (
        await classify({ direction, hasSourcePhoto: true, objectPhotos: 1 })
      ).json();
      expect({ direction, withOne }).toEqual({ direction, withOne: without });
    }
  });
});

// ─── PR 19 (B): her Style tile, counted ─────────────────────────────────────────────────────────

describe("stylePhotos — the look pointer's count (PR 19, STUDIO_IMAGE_OPS)", () => {
  afterEach(() => {
    delete process.env.STUDIO_IMAGE_OPS;
  });

  it("with a Style reference attached, 'match this look' routes to its look; without one, it asks where to attach it", async () => {
    process.env.STUDIO_IMAGE_OPS = "true";
    const withStyle = await (
      await classify({
        direction: "match this look",
        hasSourcePhoto: true,
        stylePhotos: 1,
      })
    ).json();
    expect([withStyle.initialPath, withStyle.op]).toEqual([
      "FULL_IMAGE",
      "GLOBAL_STYLE",
    ]);
    const without = await (await withPhoto("match this look")).json();
    expect([without.initialPath, without.reason]).toEqual([
      "ASK",
      "style_reference_missing",
    ]);
  });

  it("is an unknown field with STUDIO_IMAGE_OPS off — refused, never silently read", async () => {
    const res = await classify({
      direction: "match this look",
      hasSourcePhoto: true,
      stylePhotos: 1,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("stylePhotos");
  });
});
