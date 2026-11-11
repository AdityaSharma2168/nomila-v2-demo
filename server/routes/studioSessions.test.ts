/**
 * studioSessions.test.ts — the thread routes, end to end over HTTP against in-memory Postgres (PGlite).
 *
 * The store's own suite (studio/sessions.test.ts) proves the tenancy, the claim and the hydration. This one proves
 * the SURFACE: that the routes don't exist unless both flags say so, that nothing reaches the store without an
 * authenticated athlete, that bad input is a 400, and that not-yours and not-found are the same response, byte for
 * byte, on every route that takes an id. And that none of it can spend: the import graph of the router and the
 * store is walked, and no spend-path module is in it.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  // No token → 401, as the real one answers; "no athlete" → through, with no athleteId, for requireAthlete.
  requireAuth: (req: any, res: any, next: any) => {
    const who = (globalThis as any).__TEST_ATHLETE_ID;
    if (who === undefined) {
      res
        .status(401)
        .json({ error: "Missing or malformed Authorization header" });
      return;
    }
    if (who !== "no-athlete") req.athleteId = who;
    next();
  },
}));
jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(
    async (p: string) => `https://signed.example/opaque-${p.length}`,
  ),
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import studioSessionsRouter from "./studioSessions";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";
import {
  studioGenerationPreviews,
  studioSessionEntries,
  studioSessions,
} from "../../shared/schema";

let server: Server;
let base: string;
let A: string;
let B: string;

const asUser = (id: string | undefined) => {
  (globalThis as any).__TEST_ATHLETE_ID = id;
};
const uuid = () => randomUUID();

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const reply = async (res: Response) => ({
  status: res.status,
  body: await res.json(),
});

const MATERIAL = {
  promptEntryId: null,
  sent: [],
  frameAssetId: null,
  carriedOn: false,
  format: "photo",
};
const prompt = (text = "make it warmer") => ({
  id: uuid(),
  kind: "prompt",
  text,
  payload: {},
});

async function seedPreview(owner: string): Promise<string> {
  const [row] = await db
    .insert(studioGenerationPreviews)
    .values({
      athlete_id: owner,
      brief: {
        job: { source: { ref: "athletes/x/SECRET-SOURCE.jpg" } },
        gaps: [],
      },
      plan: { secret: "SECRET-PLAN" },
      cost_usd: "0.1344",
      status: "ready",
      expires_at: new Date(Date.now() + 30 * 60_000),
    } as never)
    .returning({ id: studioGenerationPreviews.id });
  return row.id;
}

beforeAll(async () => {
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_SESSIONS = "true";
  await initTestDb();
  A = await seedAthlete("Athlete A");
  B = await seedAthlete("Athlete B");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", studioSessionsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
});

beforeEach(() => {
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_SESSIONS = "true";
  asUser(A);
});

// ─── The gate ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the gate", () => {
  const routes = (id: string) =>
    [
      ["GET", "/studio/sessions", undefined],
      ["GET", `/studio/sessions/${id}`, undefined],
      ["POST", `/studio/sessions/${id}/entries`, prompt()],
      ["PATCH", `/studio/sessions/${id}`, { archived: true }],
    ] as const;

  it.each([
    ["STUDIO_SESSIONS off", "true", "false"],
    ["STUDIO_ENABLED off", "false", "true"],
    ["both off", "false", "false"],
  ])(
    "404s every route with %s — and writes nothing",
    async (_label, enabled, sessions) => {
      process.env.STUDIO_ENABLED = enabled;
      process.env.STUDIO_SESSIONS = sessions;
      const id = uuid();
      for (const [method, path, body] of routes(id)) {
        expect(await reply(await call(method, path, body))).toEqual({
          status: 404,
          body: { error: "Not found" },
        });
      }
      expect(
        await db.select().from(studioSessions).where(eq(studioSessions.id, id)),
      ).toEqual([]);
    },
  );

  it("reads the flags at call time, so flipping one needs no restart", async () => {
    process.env.STUDIO_SESSIONS = "false";
    expect((await call("GET", "/studio/sessions")).status).toBe(404);
    process.env.STUDIO_SESSIONS = "true";
    expect((await call("GET", "/studio/sessions")).status).toBe(200);
  });

  it("401s every route without a token — the flag check comes first, the store is never reached", async () => {
    asUser(undefined);
    const id = uuid();
    for (const [method, path, body] of routes(id))
      expect((await call(method, path, body)).status).toBe(401);
    expect(
      await db.select().from(studioSessions).where(eq(studioSessions.id, id)),
    ).toEqual([]);
  });

  it("403s an authenticated principal that is not an athlete", async () => {
    asUser("no-athlete");
    for (const [method, path, body] of routes(uuid()))
      expect((await call(method, path, body)).status).toBe(403);
  });
});

// ─── The surface, end to end ──────────────────────────────────────────────────────────────────────────────

describe("a thread, over HTTP", () => {
  it("appends (201), replays a retry (200), reads back, lists, archives and restores", async () => {
    const id = uuid();
    const entry = prompt("make the sky pink");

    const first = await reply(
      await call("POST", `/studio/sessions/${id}/entries`, entry),
    );
    expect(first).toEqual({
      status: 201,
      body: { sessionId: id, entryId: entry.id, seq: expect.any(Number) },
    });
    const again = await reply(
      await call("POST", `/studio/sessions/${id}/entries`, entry),
    );
    expect(again).toEqual({ status: 200, body: first.body });

    const preview = await seedPreview(A);
    const plan = {
      id: uuid(),
      kind: "plan",
      previewId: preview,
      payload: { ...MATERIAL, promptEntryId: entry.id },
    };
    expect(
      (await call("POST", `/studio/sessions/${id}/entries`, plan)).status,
    ).toBe(201);

    const page = await reply(await call("GET", `/studio/sessions/${id}`));
    expect(page.status).toBe(200);
    expect(page.body.session).toMatchObject({
      id,
      title: "make the sky pink",
      archived: false,
    });
    expect(page.body.entries.map((e: { kind: string }) => e.kind)).toEqual([
      "prompt",
      "plan",
    ]);
    expect(page.body.entries[1]).toMatchObject({
      previewId: preview,
      state: "checked",
      run: null,
    });
    expect(page.body.earlier).toBeNull();
    expect(JSON.stringify(page.body)).not.toMatch(
      /SECRET|athletes\/|"brief"\s*:|"plan"\s*:/,
    );

    const list = await reply(await call("GET", "/studio/sessions"));
    expect(list.body.sessions.map((s: { id: string }) => s.id)).toContain(id);

    const archived = await reply(
      await call("PATCH", `/studio/sessions/${id}`, { archived: true }),
    );
    expect(archived).toMatchObject({
      status: 200,
      body: { session: { id, archived: true } },
    });
    expect(
      (await reply(await call("GET", "/studio/sessions"))).body.sessions.map(
        (s: { id: string }) => s.id,
      ),
    ).not.toContain(id);
    expect(
      (
        await reply(await call("GET", "/studio/sessions?archived=true"))
      ).body.sessions.map((s: { id: string }) => s.id),
    ).toContain(id);

    expect(
      (
        await reply(
          await call("PATCH", `/studio/sessions/${id}`, { archived: false }),
        )
      ).body.session.archived,
    ).toBe(false);
  });

  it("answers the EFFECTIVE sessionId — another athlete's id gets her a fresh thread", async () => {
    const theirs = uuid();
    asUser(B);
    expect(
      (await call("POST", `/studio/sessions/${theirs}/entries`, prompt()))
        .status,
    ).toBe(201);
    asUser(A);
    const mine = await reply(
      await call("POST", `/studio/sessions/${theirs}/entries`, prompt()),
    );
    expect(mine.status).toBe(201);
    expect(mine.body.sessionId).not.toBe(theirs);
  });

  it("pages back with before=<seq>", async () => {
    const id = uuid();
    for (let i = 0; i < 3; i++)
      await call("POST", `/studio/sessions/${id}/entries`, prompt(`n${i}`));
    const last = await reply(
      await call("GET", `/studio/sessions/${id}?limit=2`),
    );
    expect(last.body.entries.map((e: { text: string }) => e.text)).toEqual([
      "n1",
      "n2",
    ]);
    const earlier = await reply(
      await call(
        "GET",
        `/studio/sessions/${id}?limit=2&before=${last.body.earlier}`,
      ),
    );
    expect(earlier.body.entries.map((e: { text: string }) => e.text)).toEqual([
      "n0",
    ]);
    expect(earlier.body.earlier).toBeNull();
  });
});

// ─── Bad input ────────────────────────────────────────────────────────────────────────────────────────────

describe("bad input", () => {
  it.each([
    ["an unknown key", { ...prompt(), athleteId: "x" }, "athleteId"],
    [
      "prose in an ask code",
      {
        id: uuid(),
        kind: "ask",
        payload: { ...MATERIAL, reason: "please rephrase that" },
      },
      "payload.reason",
    ],
    [
      "an unknown payload key",
      {
        id: uuid(),
        kind: "ask",
        payload: { ...MATERIAL, reason: "x", note: "hi" },
      },
      "payload.note",
    ],
    [
      "a role we don't have",
      {
        id: uuid(),
        kind: "ask",
        payload: {
          ...MATERIAL,
          reason: "x",
          sent: [{ assetId: randomUUID(), role: "person" }],
        },
      },
      "payload.sent[0].role",
    ],
    // express.json() hands an empty request an empty object, so this is the first missing field.
    ["no body at all", undefined, "id"],
  ])(
    "400s an append with %s, and writes nothing",
    async (_label, body, field) => {
      const id = uuid();
      const res = await reply(
        await call("POST", `/studio/sessions/${id}/entries`, body),
      );
      expect(res).toMatchObject({ status: 400, body: { field } });
      expect(
        await db.select().from(studioSessions).where(eq(studioSessions.id, id)),
      ).toEqual([]);
    },
  );

  it.each([
    ["an empty body", {}],
    ["a string", { archived: "yes" }],
    ["an extra key", { archived: true, title: "renamed" }],
  ])("400s an archive with %s", async (_label, body) => {
    const id = uuid();
    await call("POST", `/studio/sessions/${id}/entries`, prompt());
    expect((await call("PATCH", `/studio/sessions/${id}`, body)).status).toBe(
      400,
    );
  });

  it("400s a `before` that isn't a seq, rather than answering the newest page again", async () => {
    for (const before of ["abc", "0", "-5", "1.5"]) {
      expect(
        (await call("GET", `/studio/sessions/${uuid()}?before=${before}`))
          .status,
      ).toBe(400);
    }
  });

  it("404s a path id that isn't a uuid, on every route", async () => {
    expect((await call("GET", "/studio/sessions/not-a-uuid")).status).toBe(404);
    expect(
      (await call("POST", "/studio/sessions/not-a-uuid/entries", prompt()))
        .status,
    ).toBe(404);
    expect(
      (await call("PATCH", "/studio/sessions/not-a-uuid", { archived: true }))
        .status,
    ).toBe(404);
  });
});

// ─── Not yours ≡ not found ────────────────────────────────────────────────────────────────────────────────

describe("not-yours is not-found, byte for byte", () => {
  let hers: string;

  beforeAll(async () => {
    hers = uuid();
    asUser(A);
    await call("POST", `/studio/sessions/${hers}/entries`, prompt("A's words"));
  });

  it("reading A's thread as B", async () => {
    asUser(B);
    const theirs = await reply(await call("GET", `/studio/sessions/${hers}`));
    const nobody = await reply(await call("GET", `/studio/sessions/${uuid()}`));
    expect(theirs).toEqual(nobody);
    expect(theirs.status).toBe(404);
  });

  it("archiving A's thread as B — and A's thread is untouched", async () => {
    asUser(B);
    const theirs = await reply(
      await call("PATCH", `/studio/sessions/${hers}`, { archived: true }),
    );
    const nobody = await reply(
      await call("PATCH", `/studio/sessions/${uuid()}`, { archived: true }),
    );
    expect(theirs).toEqual(nobody);
    expect(theirs.status).toBe(404);
    const [row] = await db
      .select()
      .from(studioSessions)
      .where(eq(studioSessions.id, hers));
    expect(row.archived_at).toBeNull();
  });

  it("naming A's preview in B's plan", async () => {
    const preview = await seedPreview(A);
    asUser(B);
    const plan = (previewId: string) => ({
      id: uuid(),
      kind: "plan",
      previewId,
      payload: MATERIAL,
    });
    const theirs = await reply(
      await call("POST", `/studio/sessions/${uuid()}/entries`, plan(preview)),
    );
    const nobody = await reply(
      await call("POST", `/studio/sessions/${uuid()}/entries`, plan(uuid())),
    );
    expect(theirs).toEqual(nobody);
    expect(theirs).toEqual({
      status: 404,
      body: { error: "That isn't in your Studio", field: "previewId" },
    });
    expect(
      await db
        .select()
        .from(studioSessionEntries)
        .where(eq(studioSessionEntries.preview_id, preview)),
    ).toEqual([]);
  });

  it("the list is hers only", async () => {
    asUser(B);
    const list = await reply(await call("GET", "/studio/sessions"));
    expect(list.body.sessions.map((s: { id: string }) => s.id)).not.toContain(
      hers,
    );
  });
});

// ─── The limiter ──────────────────────────────────────────────────────────────────────────────────────────

describe("the append limiter", () => {
  it("429s an athlete's 61st append in a minute — per athlete, so another athlete is unaffected", async () => {
    const busy = await seedAthlete("Busy Athlete");
    asUser(busy);
    const id = uuid();
    // Refused bodies count too: the limiter sits in front of validation, which is the point of it.
    for (let i = 0; i < 60; i++)
      expect(
        (await call("POST", `/studio/sessions/${id}/entries`, {})).status,
      ).toBe(400);
    expect(
      (await call("POST", `/studio/sessions/${id}/entries`, prompt())).status,
    ).toBe(429);
    asUser(B);
    expect(
      (await call("POST", `/studio/sessions/${uuid()}/entries`, prompt()))
        .status,
    ).toBe(201);
    asUser(busy);
    expect((await call("GET", `/studio/sessions`)).status).toBe(200); // reads are not limited
  });
});

// ─── No spend surface ─────────────────────────────────────────────────────────────────────────────────────

describe("no spend surface", () => {
  const SERVER = join(__dirname, "..");
  const REPO = join(SERVER, "..");
  /**
   * Comments out first: a sentence ABOUT an import must not count as one. Block comments only where a line opens
   * one (a "image/*" string mid-line must not start a comment that swallows real code), line comments anywhere
   * but after a colon (a url).
   */
  const code = (src: string) =>
    src
      .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const SPEC =
    /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;

  /** Every repo file reachable from `entry` by a relative import — value or type, static or dynamic. */
  function reach(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of code(readFileSync(file, "utf8")).matchAll(SPEC)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (!spec.startsWith(".")) continue; // a package
        const stem = resolve(dirname(file), spec.replace(/\.js$/, ""));
        const hit = [`${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts")].find(
          (c) => existsSync(c),
        );
        if (hit) stack.push(hit);
      }
    }
    return new Set([...seen].map((f) => relative(REPO, f)));
  }

  const SPEND = [
    "server/studio/generate.ts",
    "server/studio/router.ts",
    "server/studio/adapters/",
    "server/studio/interpret/",
    "server/studio/compile/",
    "server/studio/qa/",
    "server/lib/models.ts",
  ];
  const spendIn = (files: Set<string>) =>
    [...files].filter((f) => SPEND.some((s) => f === s || f.startsWith(s)));

  it("the walk can see a spend path — routes/studio.ts reaches generate, the adapters, the interpreter and the compiler", () => {
    const hit = spendIn(reach(join(SERVER, "routes", "studio.ts")));
    for (const s of [
      "server/studio/generate.ts",
      "server/studio/adapters/",
      "server/studio/interpret/",
      "server/studio/compile/",
    ]) {
      expect(hit.some((f) => f.startsWith(s))).toBe(true);
    }
  });

  it("neither the router nor the store reaches any of it", () => {
    const fromRouter = reach(join(SERVER, "routes", "studioSessions.ts"));
    expect(fromRouter).toContain("server/studio/sessions.ts"); // the walk followed the router into the store
    expect(spendIn(fromRouter)).toEqual([]);
    expect(spendIn(reach(join(SERVER, "studio", "sessions.ts")))).toEqual([]);
  });

  it("is mounted by the app, beside the studio router", () => {
    const index = readFileSync(join(SERVER, "index.ts"), "utf8");
    expect(index).toContain(
      'import studioSessionsRouter from "./routes/studioSessions";',
    );
    expect(index).toContain('app.use("/api/v1/me", studioSessionsRouter);');
  });
});
