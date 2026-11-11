import {
  afterGenerate,
  appendDisposition,
  appendFailureReason,
  askBody,
  checkAgainJob,
  composerAfterReject,
  continuationFrame,
  editFromChat,
  gateLineFor,
  generateFailure,
  historyPlanView,
  listReadFor,
  livePlanFrom,
  livePlanView,
  LOST_NOTE,
  MAX_APPEND_RETRIES,
  MAX_SENT_REFS,
  materialOf,
  notSavedLine,
  planBody,
  jobReadFromStitch,
  outputFromRun,
  pollOutcome,
  pollProgress,
  watchLimitMs,
  promptBody,
  recoverLost,
  relativeTime,
  resolveThread,
  retryDelayMs,
  roleLabel,
  runsToWatch,
  STALL_AFTER_MS,
  supersededIds,
  threadReadFor,
  toHistory,
  trayRole,
  type JobRead,
  type SheetJob,
  type ThreadPage,
  type WireAsset,
  type WireEntry,
  type WirePlanEntry,
  type WirePreview,
} from "./threadLogic";
import {
  askCopyFor,
  nextFrameAssetId,
  type Attachment,
  type PickableRole,
} from "../../lib/studio-contract";
import { FRAME_ASK } from "./createAnythingLogic";

// ─── Fixtures (synthetic) ──────────────────────────────────────────────────────────────────────────────

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PHOTO = id(101);
const PRODUCT = id(102);
const OUTPUT = id(201);
const OUTPUT_2 = id(202);

const asset = (over: Partial<WireAsset> = {}): WireAsset => ({
  mediaType: "IMAGE",
  thumbUrl: "https://signed.example/thumb",
  url: null,
  approvalStatus: "draft",
  state: "ok",
  ...over,
});

const preview = (over: Partial<WirePreview> = {}): WirePreview => ({
  status: "ready",
  costUsd: 0.13,
  unpriced: false,
  expired: false,
  rejected: false,
  card: null,
  askReason: null,
  blockingNote: null,
  ...over,
});

let seq = 0;
const prompt = (
  entryId: string,
  text: string,
  stoppedFor: "product" | "photo" | null = null,
): WireEntry => ({
  id: entryId,
  seq: ++seq,
  createdAt: "2026-09-15T10:00:00.000Z",
  kind: "prompt",
  text,
  stoppedFor,
});

const plan = (
  entryId: string,
  over: Partial<WirePlanEntry> = {},
): WirePlanEntry => ({
  id: entryId,
  seq: ++seq,
  createdAt: "2026-09-15T10:00:01.000Z",
  kind: "plan",
  previewId: id(900 + seq),
  state: "checked",
  preview: preview(),
  run: null,
  promptEntryId: id(1),
  sent: [{ assetId: PHOTO, role: "source-frame" }],
  frameAssetId: PHOTO,
  carriedOn: false,
  format: "photo",
  ...over,
});

const page = (
  entries: WireEntry[],
  assets: Record<string, WireAsset> = {},
  earlier: number | null = null,
): ThreadPage => ({
  session: {
    id: id(500),
    title: "t",
    archived: false,
    createdAt: "",
    updatedAt: "",
  },
  entries,
  assets,
  earlier,
});

const ASSETS: Record<string, WireAsset> = {
  [PHOTO]: asset(),
  [PRODUCT]: asset(),
  [OUTPUT]: asset({ url: "https://signed.example/full" }),
};
const PROMPTS = new Map([[id(1), "make the sky pink"]]);
const view = (
  entry: WirePlanEntry,
  over: Partial<Parameters<typeof historyPlanView>[1]> = {},
) =>
  historyPlanView(entry, {
    assets: ASSETS,
    prompts: PROMPTS,
    collapsed: new Set(),
    ...over,
  });

const tray = (
  role: PickableRole,
  assetId: string,
): Attachment & { role: PickableRole } => ({
  id: `${role}:${assetId}`,
  role,
  name: role,
  uri: `https://signed.example/${assetId}`,
  assetId,
});

const job = (over: Partial<SheetJob> = {}): SheetJob => ({
  key: "k1",
  promptEntryId: id(1),
  prompt: "make the sky pink",
  attachments: [tray("source-frame", PHOTO)],
  frameAssetId: PHOTO,
  carriedOn: false,
  format: "photo",
  ...over,
});

// ─── Which 404 is which ────────────────────────────────────────────────────────────────────────────────

describe("reading the server's answers", () => {
  it("a 404 on the LIST is the surface switched off — session-only, not an error", () => {
    expect(listReadFor(200)).toBe("ok");
    expect(listReadFor(404)).toBe("unavailable");
    expect(listReadFor(500)).toBe("error");
    expect(listReadFor(403)).toBe("error");
  });

  it("a 404 on ONE THREAD is a thread nobody has appended to yet — empty, not an error", () => {
    expect(threadReadFor(200)).toBe("ok");
    expect(threadReadFor(404)).toBe("unclaimed");
    expect(threadReadFor(500)).toBe("error");
    expect(threadReadFor(401)).toBe("error");
  });
});

// ─── The door (D2a) ────────────────────────────────────────────────────────────────────────────────────

describe("which thread the door opens", () => {
  const mint = () => "minted";
  const summary = (sid: string, archived = false) => ({
    id: sid,
    title: null,
    archived,
    createdAt: "",
    updatedAt: "",
    thumbUrl: null,
  });

  it("opens the thread she named, whatever the list says", () => {
    expect(resolveThread("named", { kind: "loading" }, mint)).toEqual({
      kind: "thread",
      sessionId: "named",
    });
    expect(resolveThread("named", { kind: "error" }, mint)).toEqual({
      kind: "thread",
      sessionId: "named",
    });
  });

  it("resumes her latest open thread", () => {
    expect(
      resolveThread(
        undefined,
        { kind: "ok", sessions: [summary("latest"), summary("older")] },
        mint,
      ),
    ).toEqual({
      kind: "thread",
      sessionId: "latest",
    });
  });

  it("never resumes an archived thread, even from a list that carried one", () => {
    expect(
      resolveThread(
        undefined,
        { kind: "ok", sessions: [summary("gone", true), summary("open")] },
        mint,
      ),
    ).toEqual({
      kind: "thread",
      sessionId: "open",
    });
  });

  it("mints a new thread when she has none, and when the server has threads switched off", () => {
    expect(
      resolveThread(undefined, { kind: "ok", sessions: [] }, mint),
    ).toEqual({ kind: "thread", sessionId: "minted" });
    expect(resolveThread(undefined, { kind: "unavailable" }, mint)).toEqual({
      kind: "thread",
      sessionId: "minted",
    });
  });

  it("waits for the list, and on a failed list asks her to retry — never an empty thread over hers", () => {
    expect(resolveThread(undefined, { kind: "loading" }, mint)).toEqual({
      kind: "waiting",
    });
    expect(resolveThread(undefined, { kind: "error" }, mint)).toEqual({
      kind: "error",
    });
  });
});

// ─── Saving ────────────────────────────────────────────────────────────────────────────────────────────

describe("the append queue's policy", () => {
  it("is done on 201 and on 200 (a replay of an entry already saved)", () => {
    expect(appendDisposition(201)).toBe("done");
    expect(appendDisposition(200)).toBe("done");
  });

  it("retries what may answer differently in a moment", () => {
    for (const s of [408, 429, 500, 502, 503] as const)
      expect(appendDisposition(s)).toBe("retry");
    expect(appendDisposition("network")).toBe("retry");
  });

  it("does not retry an answer that cannot change — a refused body, an id not hers, a full thread", () => {
    for (const s of [400, 401, 403, 404, 409, 422] as const)
      expect(appendDisposition(s)).toBe("fail");
  });

  it("retries three times, 1s, 2s, 4s apart", () => {
    expect(MAX_APPEND_RETRIES).toBe(3);
    expect([1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000]);
  });

  it("tells a full thread from a taken id — only the first is hers to act on", () => {
    expect(appendFailureReason(409, "sessionId")).toBe("full");
    expect(appendFailureReason(409, "id")).toBe("failed");
    expect(appendFailureReason(404, "sessionId")).toBe("failed");
    expect(appendFailureReason("network", undefined)).toBe("failed");
  });

  it("says Not saved quietly, and why only when the reason is hers to act on", () => {
    expect(notSavedLine("failed")).toBe("Not saved");
    expect(notSavedLine("full")).toMatch(/full.*\+/);
  });
});

// ─── Roles (the total map) ─────────────────────────────────────────────────────────────────────────────

describe("a stored role, in her words", () => {
  it("names every role she can pick", () => {
    expect(roleLabel("source-frame")).toBe("Your media");
    expect(roleLabel("product")).toBe("Product");
    expect(roleLabel("object")).toBe("Object");
  });

  it("falls back for a role this build has not heard of — never the raw enum", () => {
    expect(roleLabel("brand-imagery")).toBe("Attachment");
    expect(roleLabel("")).toBe("Attachment");
  });

  it("falls back for the names every object carries — never a function printed as text", () => {
    for (const r of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(roleLabel(r)).toBe("Attachment");
    }
  });

  it("gives the tray back only the roles the picker can make", () => {
    expect(trayRole("object")).toBe("object");
    expect(trayRole("inspiration")).toBeNull();
    expect(trayRole("constructor")).toBeNull();
  });
});

// ─── Material ──────────────────────────────────────────────────────────────────────────────────────────

describe("what a plan stores about what went into it", () => {
  it("ids and roles only, from attachments that have an asset row", () => {
    const m = materialOf(
      job({
        attachments: [
          tray("source-frame", PHOTO),
          { ...tray("product", PRODUCT), assetId: null },
        ],
        carriedOn: true,
      }),
    );
    expect(m).toEqual({
      promptEntryId: id(1),
      sent: [{ assetId: PHOTO, role: "source-frame" }],
      frameAssetId: PHOTO,
      carriedOn: true,
      format: "photo",
    });
  });

  it(`caps what it names at ${MAX_SENT_REFS}, so an over-full tray cannot cost the whole entry`, () => {
    expect(MAX_SENT_REFS).toBe(12);
    const many = Array.from({ length: 15 }, (_, i) =>
      tray("object", id(300 + i)),
    );
    const m = materialOf(job({ attachments: many }));
    expect(m.sent).toHaveLength(12);
    expect(m.sent[0].assetId).toBe(id(300));
    expect(m.sent[11].assetId).toBe(id(311));
  });

  it("never the preview the send already checked (C2's seed) — a seeded job stores exactly what an unseeded one does", () => {
    const seeded = job({
      seed: {
        request: {
          intent: "image.edit",
          deliverable: "post",
          objective: "grow-following",
          direction: "make the sky pink",
          brandId: null,
          sourceAssetId: PHOTO,
        },
        preview: {
          previewId: "pv-seed",
          status: "ready",
          plan: null,
          references: [],
          cost: null,
          unpriced: false,
          blockers: [],
          warnings: [],
          verdict: { canGenerate: true, headline: "Ready", reason: null },
          unavailable: null,
          interpretation: {
            lines: [
              { kind: "change", text: "make the sky pink", source: "yours" },
            ],
          },
        },
      },
    });
    expect(materialOf(seeded)).toStrictEqual(materialOf(job()));
    expect(planBody(id(2), id(800), seeded)).toStrictEqual(
      planBody(id(2), id(800), job()),
    );
    expect(askBody(id(3), "fast_path_declined", seeded)).toStrictEqual(
      askBody(id(3), "fast_path_declined", job()),
    );
    expect(JSON.stringify(planBody(id(2), id(800), seeded))).not.toMatch(
      /pv-seed|seed|interpretation/,
    );
  });
});

describe("an append's body — the server's closed shape, nothing more", () => {
  // server/studio/sessions.ts parseEntry: MATERIAL_KEYS, plus `reason` on an ask. Hand-written, so a key added on
  // one side alone goes red here instead of 400ing every append in production.
  const MATERIAL_KEYS = [
    "carriedOn",
    "format",
    "frameAssetId",
    "promptEntryId",
    "sent",
  ];

  it("a prompt carries her words and, only when a gate stopped it, which one", () => {
    expect(promptBody(id(1), "make it pink", null)).toEqual({
      id: id(1),
      kind: "prompt",
      text: "make it pink",
      payload: {},
    });
    expect(promptBody(id(1), "a photo of me", "photo").payload).toEqual({
      stoppedFor: "photo",
    });
  });

  it("a plan names its preview and exactly the material keys", () => {
    const b = planBody(id(2), id(800), job());
    expect(Object.keys(b).sort()).toEqual([
      "id",
      "kind",
      "payload",
      "previewId",
    ]);
    expect(Object.keys(b.payload).sort()).toEqual(MATERIAL_KEYS);
    expect(
      Object.keys((b.payload as { sent: object[] }).sent[0]).sort(),
    ).toEqual(["assetId", "role"]);
  });

  it("an ask carries its code beside the same material, and no preview", () => {
    const b = askBody(id(3), "person_target", job());
    expect(Object.keys(b).sort()).toEqual(["id", "kind", "payload"]);
    expect(Object.keys(b.payload).sort()).toEqual(
      [...MATERIAL_KEYS, "reason"].sort(),
    );
    expect((b.payload as { reason: string }).reason).toBe("person_target");
  });

  it("the frame ask is an ask the server accepts, carrying the tray she sent and the photo she marked", () => {
    // Its material never opened a sheet, so it has no key. The code must pass sessions.ts's REASON_RE,
    // hand-copied here beside MATERIAL_KEYS for the same reason: a code it refuses is an entry lost every time.
    const PHOTO_2 = id(103);
    const material: Omit<SheetJob, "key"> = {
      promptEntryId: id(1),
      prompt: "make the socks blue",
      attachments: [tray("source-frame", PHOTO), tray("source-frame", PHOTO_2)],
      frameAssetId: PHOTO_2,
      carriedOn: false,
      format: "photo",
    };
    const b = askBody(id(3), FRAME_ASK, material);
    expect(FRAME_ASK).toMatch(/^[a-z_]{1,40}$/);
    expect(Object.keys(b).sort()).toEqual(["id", "kind", "payload"]);
    expect(Object.keys(b.payload).sort()).toEqual(
      [...MATERIAL_KEYS, "reason"].sort(),
    );
    expect(b.payload).toMatchObject({
      reason: FRAME_ASK,
      frameAssetId: PHOTO_2,
      sent: [
        { assetId: PHOTO, role: "source-frame" },
        { assetId: PHOTO_2, role: "source-frame" },
      ],
    });
  });
});

// ─── Superseded plans ──────────────────────────────────────────────────────────────────────────────────

describe("which plans collapse", () => {
  it("an unspent plan with a later plan for the same words folds", () => {
    const out = supersededIds([
      { id: "a", promptEntryId: "p", consumed: false },
      { id: "b", promptEntryId: "p", consumed: false },
    ]);
    expect([...out]).toEqual(["a"]);
  });

  it("a spent plan never folds — it is where an output came from", () => {
    const out = supersededIds([
      { id: "a", promptEntryId: "p", consumed: true },
      { id: "b", promptEntryId: "p", consumed: false },
    ]);
    expect(out.size).toBe(0);
  });

  it("every unspent plan but the last folds, across three", () => {
    const out = supersededIds([
      { id: "a", promptEntryId: "p", consumed: false },
      { id: "b", promptEntryId: "p", consumed: false },
      { id: "c", promptEntryId: "p", consumed: false },
    ]);
    expect([...out].sort()).toEqual(["a", "b"]);
  });

  it("plans for different words, and plans with no words to group under, stand alone", () => {
    const out = supersededIds([
      { id: "a", promptEntryId: "p", consumed: false },
      { id: "b", promptEntryId: "q", consumed: false },
      { id: "c", promptEntryId: null, consumed: false },
      { id: "d", promptEntryId: null, consumed: false },
    ]);
    expect(out.size).toBe(0);
  });
});

// ─── History ───────────────────────────────────────────────────────────────────────────────────────────

describe("pages into history", () => {
  it("renders oldest first across pages fetched newest first", () => {
    const older = page(
      [prompt(id(1), "one"), plan(id(2))],
      { [PHOTO]: asset() },
      null,
    );
    const newer = page(
      [prompt(id(3), "two"), plan(id(4), { promptEntryId: id(3) })],
      { [OUTPUT]: asset() },
      7,
    );
    const h = toHistory([newer, older], new Set());
    expect(h.items.map((i) => i.key)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(Object.keys(h.assets).sort()).toEqual([PHOTO, OUTPUT].sort());
    expect(h.earlier).toBeNull();
  });

  it("offers Load earlier from the oldest page loaded", () => {
    const h = toHistory([page([prompt(id(3), "two")], {}, 41)], new Set());
    expect(h.earlier).toBe(41);
  });

  it("leaves out what this mount made — it is already on screen — but still knows her words", () => {
    const h = toHistory(
      [page([prompt(id(1), "mine, just now"), plan(id(2))])],
      new Set([id(1), id(2)]),
    );
    expect(h.items).toHaveLength(0);
    expect(h.prompts.get(id(1))).toBe("mine, just now");
  });

  it("skips a kind this build does not know, and an entry seen twice", () => {
    const future = {
      ...prompt(id(9), "x"),
      kind: "memo",
    } as unknown as WireEntry;
    const twice = prompt(id(1), "one");
    const h = toHistory([page([twice, future]), page([twice])], new Set());
    expect(h.items.map((i) => i.key)).toEqual([id(1)]);
  });

  it("a stored frame ask comes back as Mila's question, in its place — never as the catch-all", () => {
    const ask: WireEntry = {
      id: id(5),
      seq: ++seq,
      createdAt: "2026-09-16T10:00:00.000Z",
      kind: "ask",
      reason: FRAME_ASK,
      promptEntryId: id(1),
      sent: [{ assetId: PHOTO, role: "source-frame" }],
      frameAssetId: PHOTO,
      carriedOn: false,
      format: "photo",
    };
    const h = toHistory(
      [page([prompt(id(1), "make the socks blue"), ask])],
      new Set(),
    );
    expect(h.items.map((i) => [i.key, i.kind])).toEqual([
      [id(1), "prompt"],
      [id(5), "ask"],
    ]);
    const item = h.items[1];
    if (item.kind !== "ask") throw new Error("not an ask");
    // What renderHistory says for it.
    expect(askCopyFor(item.entry.reason)).toMatch(/marked one photo to edit/);
    expect(askCopyFor(item.entry.reason)).not.toBe(askCopyFor("zzz"));
  });

  it("says what stopped a gated prompt, since the gate's own card was never stored", () => {
    expect(gateLineFor("photo")).toMatch(/photo of you/);
    expect(gateLineFor("product")).toMatch(/product/);
    expect(gateLineFor(null)).toBeNull();
  });
});

// ─── Every card state ──────────────────────────────────────────────────────────────────────────────────

describe("a history plan card, in every state", () => {
  it("checked: the server's own figure, and Check again", () => {
    const v = view(plan(id(2)));
    expect(v.headline).toBe("Checked · $0.13");
    expect(v.checkAgain).toBe(true);
    expect(v.loading).toBe(false);
    expect(v.outputs).toEqual([]);
  });

  it("checked and free says free; unpriced says no figure at all", () => {
    expect(
      view(plan(id(2), { preview: preview({ costUsd: 0 }) })).headline,
    ).toBe("Checked · free");
    expect(
      view(plan(id(2), { preview: preview({ unpriced: true }) })).headline,
    ).toBe("Checked");
  });

  it("expired: says so, and offers a fresh check", () => {
    const v = view(
      plan(id(2), { state: "expired", preview: preview({ expired: true }) }),
    );
    expect(v.headline).toBe("That check expired");
    expect(v.checkAgain).toBe(true);
  });

  it("gone: the preview row is no longer there, and there is nothing to check again from", () => {
    const v = view(
      plan(id(2), { state: "gone", preview: null, previewId: null }),
    );
    expect(v.headline).toBe("That check is no longer available");
    expect(v.checkAgain).toBe(false);
  });

  it("blocked by the interpreter's ask: its own copy", () => {
    const v = view(
      plan(id(2), {
        state: "blocked",
        preview: preview({ status: "blocked", askReason: "look_unknown" }),
      }),
    );
    expect(v.note).toBe(askCopyFor("look_unknown"));
    expect(v.checkAgain).toBe(false);
  });

  it("blocked by the interpreter's new image: the new-image line, not the catch-all — whatever the note says (the new-image exit)", () => {
    const v = view(
      plan(id(2), {
        state: "blocked",
        preview: preview({
          status: "blocked",
          askReason: "new_image",
          blockingNote:
            "That asks for a new picture of you, not a change to this photo — start a new image instead.",
        }),
      }),
    );
    expect(v.note).toBe(askCopyFor("new_image"));
    expect(v.note).not.toBe(askCopyFor("some_future_reason"));
    expect(v.checkAgain).toBe(false);
  });

  it("blocked by the check: its own blocking note, else the generic sentence", () => {
    const noted = view(
      plan(id(2), {
        state: "blocked",
        preview: preview({ status: "blocked", blockingNote: "Add a photo." }),
      }),
    );
    expect(noted.note).toBe("Add a photo.");
    const bare = view(
      plan(id(2), {
        state: "blocked",
        preview: preview({ status: "blocked" }),
      }),
    );
    expect(bare.note).toMatch(/wasn't there/);
  });

  it("not what she meant: said, and nothing offered on it", () => {
    const v = view(
      plan(id(2), { state: "not_meant", preview: preview({ rejected: true }) }),
    );
    expect(v.headline).toBe("You said that wasn't what you meant");
    expect(v.checkAgain).toBe(false);
  });

  it("making: the loading tile, where the image will land", () => {
    const v = view(
      plan(id(2), {
        state: "making",
        run: { jobId: id(700), state: "making", outputIds: [] },
      }),
    );
    expect(v.loading).toBe(true);
    expect(v.headline).toBe("Making it…");
    expect(v.checkAgain).toBe(false);
  });

  it("stalled: honest about not knowing, and a fresh check", () => {
    const v = view(
      plan(id(2), {
        state: "stalled",
        run: { jobId: id(700), state: "stalled", outputIds: [] },
      }),
    );
    expect(v.loading).toBe(false);
    expect(v.note).toMatch(/Made shelf/);
    expect(v.checkAgain).toBe(true);
  });

  it("failed: and a fresh check", () => {
    const v = view(
      plan(id(2), {
        state: "failed",
        run: { jobId: id(700), state: "failed", outputIds: [] },
      }),
    );
    expect(v.headline).toBe("That one didn't come out");
    expect(v.checkAgain).toBe(true);
  });

  it("made: its outputs, full image first, Edit this only on an image she can still read", () => {
    const assets = {
      ...ASSETS,
      [OUTPUT_2]: asset({ state: "removed", thumbUrl: null }),
      [id(203)]: asset({ mediaType: "VIDEO", url: "https://signed.example/v" }),
      [id(204)]: asset({
        approvalStatus: "rejected",
        url: "https://signed.example/r",
      }),
    };
    const v = view(
      plan(id(2), {
        state: "made",
        run: {
          jobId: id(700),
          state: "made",
          outputIds: [OUTPUT, OUTPUT_2, id(203), id(204)],
        },
      }),
      { assets },
    );
    expect(v.headline).toBe("Made");
    expect(v.checkAgain).toBe(false);
    expect(
      v.outputs.map((o) => [o.uri, o.removed, o.editable, o.rejected]),
    ).toEqual([
      ["https://signed.example/full", false, true, false],
      [null, true, false, false],
      ["https://signed.example/v", false, false, false],
      ["https://signed.example/r", false, true, true],
    ]);
  });

  it("made with nothing to show says so", () => {
    const v = view(
      plan(id(2), {
        state: "made",
        run: { jobId: id(700), state: "made", outputIds: [] },
      }),
    );
    expect(v.outputs).toEqual([]);
    expect(v.note).toMatch(/nothing came back/);
  });

  it("an output the page no longer names is a tombstone, not a hole", () => {
    const v = view(
      plan(id(2), {
        state: "made",
        run: { jobId: id(700), state: "made", outputIds: [id(299)] },
      }),
    );
    expect(v.outputs).toEqual([
      {
        assetId: id(299),
        mediaType: null,
        uri: null,
        removed: true,
        editable: false,
        rejected: false,
      },
    ]);
  });

  it("shows the card she read — the interpreter's or the rules' — either way without a way to refuse it", () => {
    const lines = [
      {
        kind: "change" as const,
        text: "Make it warmer",
        source: "yours" as const,
      },
    ];
    expect(
      view(
        plan(id(2), { preview: preview({ card: { lines, refusable: true } }) }),
      ).lines,
    ).toEqual(lines);
    expect(
      view(
        plan(id(2), {
          preview: preview({ card: { lines, refusable: false } }),
        }),
      ).lines,
    ).toEqual(lines);
    expect(view(plan(id(2))).lines).toBeNull();
  });

  it("a collapsed plan is one line, with nothing to act on", () => {
    const v = view(plan(id(2)), { collapsed: new Set([id(2)]) });
    expect(v.collapsed).toBe(true);
    expect(v.headline).toBe("Checked again below");
    expect(v.checkAgain).toBe(false);
  });

  it("what a watch heard beats the page it was read from", () => {
    const v = view(
      plan(id(2), {
        state: "making",
        run: { jobId: id(700), state: "making", outputIds: [] },
      }),
      {
        overlay: {
          state: "made",
          outputs: [
            {
              assetId: OUTPUT,
              mediaType: "IMAGE",
              uri: "u",
              removed: false,
              editable: true,
              rejected: false,
            },
          ],
        },
      },
    );
    expect(v.state).toBe("made");
    expect(v.loading).toBe(false);
    expect(v.outputs.map((o) => o.assetId)).toEqual([OUTPUT]);
  });

  it("labels what it was built from through the total map, and tombstones a removed photo", () => {
    const v = view(
      plan(id(2), {
        sent: [
          { assetId: PHOTO, role: "source-frame" },
          { assetId: PRODUCT, role: "brand-imagery" },
          { assetId: id(299), role: "object" },
        ],
      }),
    );
    expect(v.builtFrom.map((t) => [t.label, t.removed, t.editable])).toEqual([
      ["Your media", false, true],
      ["Attachment", false, true],
      ["Object", true, false],
    ]);
  });
});

// ─── Check again ───────────────────────────────────────────────────────────────────────────────────────

describe("check again", () => {
  it("rebuilds the sheet's job from the stored plan: her words, her photos, her frame", () => {
    const j = checkAgainJob(
      plan(id(2), {
        sent: [
          { assetId: PRODUCT, role: "product" },
          { assetId: PHOTO, role: "source-frame" },
        ],
        frameAssetId: PHOTO,
        carriedOn: true,
      }),
      "make the sky pink",
      ASSETS,
    );
    expect(j).toEqual({
      promptEntryId: id(1),
      prompt: "make the sky pink",
      attachments: [
        {
          id: `product:${PRODUCT}`,
          role: "product",
          name: "Product",
          uri: ASSETS[PRODUCT].thumbUrl,
          assetId: PRODUCT,
        },
        {
          id: `source-frame:${PHOTO}`,
          role: "source-frame",
          name: "Your media",
          uri: ASSETS[PHOTO].thumbUrl,
          assetId: PHOTO,
        },
      ],
      frameAssetId: PHOTO,
      carriedOn: true,
      format: "photo",
    });
    // Rebuilt from the thread, so nothing the send checked comes with it: Check again always asks (C2).
    expect(j).not.toHaveProperty("seed");
  });

  it("a plan sent with NO frame checks again with no frame — her photos stay references (frame defaulting)", () => {
    const PHOTO_2 = id(103);
    const j = checkAgainJob(
      plan(id(2), {
        sent: [
          { assetId: PHOTO, role: "source-frame" },
          { assetId: PHOTO_2, role: "source-frame" },
        ],
        frameAssetId: null,
      }),
      "generate pic of me playing soccer",
      { ...ASSETS, [PHOTO_2]: asset() },
    );
    expect(j?.attachments.map((a) => a.assetId)).toEqual([PHOTO, PHOTO_2]);
    expect(j?.frameAssetId).toBeNull();
  });

  it("a plan saved BEFORE the fix replays with the frame it was sent with — history is not reinterpreted", () => {
    // Its frame was defaulted in at the time, beside another photo of hers. It is still what she was shown.
    const PHOTO_2 = id(103);
    const j = checkAgainJob(
      plan(id(2), {
        sent: [
          { assetId: PHOTO, role: "source-frame" },
          { assetId: PHOTO_2, role: "source-frame" },
        ],
        frameAssetId: PHOTO,
      }),
      "generate pic of me playing soccer",
      { ...ASSETS, [PHOTO_2]: asset() },
    );
    expect(j?.frameAssetId).toBe(PHOTO);
    expect(j?.attachments.map((a) => a.assetId)).toEqual([PHOTO, PHOTO_2]);
  });

  it("needs her words", () => {
    expect(checkAgainJob(plan(id(2)), undefined, ASSETS)).toBeNull();
    expect(checkAgainJob(plan(id(2)), "   ", ASSETS)).toBeNull();
  });

  it("will not quietly check a different job: a removed or unknown photo stops it", () => {
    const removed = { ...ASSETS, [PHOTO]: asset({ state: "removed" }) };
    expect(checkAgainJob(plan(id(2)), "x", removed)).toBeNull();
    expect(
      checkAgainJob(
        plan(id(2), { sent: [{ assetId: id(299), role: "object" }] }),
        "x",
        ASSETS,
      ),
    ).toBeNull();
    expect(
      checkAgainJob(
        plan(id(2), { sent: [{ assetId: PHOTO, role: "inspiration" }] }),
        "x",
        ASSETS,
      ),
    ).toBeNull();
  });

  it("offers it on a history card only when the job can be rebuilt", () => {
    expect(view(plan(id(2)), { prompts: new Map() }).checkAgain).toBe(false);
    expect(
      view(plan(id(2), { state: "expired" }), {
        assets: { ...ASSETS, [PHOTO]: asset({ state: "removed" }) },
      }).checkAgain,
    ).toBe(false);
  });
});

// ─── Live plans ────────────────────────────────────────────────────────────────────────────────────────

describe("a live plan: the preview this mount rendered", () => {
  const sheet = {
    previewId: id(800),
    canGenerate: true,
    jobCostUsd: 0.13,
    unpriced: false,
    blockers: [] as string[],
    interpretation: null,
    card: null,
  };

  it("lands checked with the server's figure", () => {
    const p = livePlanFrom(id(2), job(), sheet);
    expect(p.state).toBe("checked");
    expect(p.previewId).toBe(id(800));
    expect(
      livePlanView(p, { collapsed: new Set(), mediaTypes: {} }).headline,
    ).toBe("Checked · $0.13");
  });

  it("lands blocked with the check's own first blocker", () => {
    const p = livePlanFrom(id(2), job(), {
      ...sheet,
      canGenerate: false,
      blockers: ["Needs a photo.", "second"],
    });
    expect(p.state).toBe("blocked");
    expect(livePlanView(p, { collapsed: new Set(), mediaTypes: {} }).note).toBe(
      "Needs a photo.",
    );
  });

  it("keeps the lines she read — the interpreter's over the rules'", () => {
    const i = [
      {
        kind: "change" as const,
        text: "interpreted",
        source: "suggested" as const,
      },
    ];
    const r = [
      { kind: "constraint" as const, text: "kept", source: "yours" as const },
    ];
    expect(
      livePlanFrom(id(2), job(), {
        ...sheet,
        interpretation: { lines: i },
        card: { lines: r },
      }).preview.card,
    ).toEqual({
      lines: i,
      refusable: true,
    });
    expect(
      livePlanFrom(id(2), job(), { ...sheet, card: { lines: r } }).preview.card,
    ).toEqual({ lines: r, refusable: false });
  });

  it("offers Edit this on what it was built from only where the photo is known to be an image", () => {
    const p = livePlanFrom(
      id(2),
      job({
        attachments: [tray("source-frame", PHOTO), tray("product", PRODUCT)],
      }),
      sheet,
    );
    const v = livePlanView(p, {
      collapsed: new Set(),
      mediaTypes: { [PHOTO]: "IMAGE", [PRODUCT]: "VIDEO" },
    });
    expect(v.builtFrom.map((t) => t.editable)).toEqual([true, false]);
  });

  it("shows the loading tile while making, then the image in place", () => {
    const p = livePlanFrom(id(2), job(), sheet);
    const making = livePlanView(
      { ...p, state: "making" },
      { collapsed: new Set(), mediaTypes: {} },
    );
    expect(making.loading).toBe(true);
    const out = [
      {
        assetId: OUTPUT,
        mediaType: "IMAGE",
        uri: "u",
        removed: false,
        editable: true,
        rejected: false,
      },
    ];
    const made = livePlanView(
      { ...p, state: "made", outputs: out },
      { collapsed: new Set(), mediaTypes: {} },
    );
    expect(made.loading).toBe(false);
    expect(made.outputs).toEqual(out);
  });

  it("offers a fresh check where history would, and folds under a later check exactly as history does", () => {
    const p = livePlanFrom(id(2), job(), sheet);
    const ctx = { collapsed: new Set<string>(), mediaTypes: {} };
    expect(livePlanView(p, ctx).checkAgain).toBe(true);
    expect(livePlanView({ ...p, state: "stalled" }, ctx).checkAgain).toBe(true);
    expect(livePlanView({ ...p, state: "making" }, ctx).checkAgain).toBe(false);
    expect(livePlanView({ ...p, state: "not_meant" }, ctx).checkAgain).toBe(
      false,
    );

    const folded = livePlanView(p, { ...ctx, collapsed: new Set([id(2)]) });
    expect(folded.collapsed).toBe(true);
    expect(folded.headline).toBe("Checked again below");
    expect(folded.checkAgain).toBe(false);
  });
});

// ─── The run ───────────────────────────────────────────────────────────────────────────────────────────

describe("what the generate response makes of the card", () => {
  const a = (url: string | null) => ({
    assetId: OUTPUT,
    mediaType: "IMAGE",
    url,
    approvalStatus: "draft",
    allowedNext: [],
  });

  it("an asset with a url is the result, in place", () => {
    const u = afterGenerate({
      jobId: id(700),
      status: "succeeded",
      assets: [a("https://signed.example/o")],
    });
    expect(u.state).toBe("made");
    expect(u.state === "made" && u.outputs[0].uri).toBe(
      "https://signed.example/o",
    );
    // And it says nothing else: "nothing came back" over a real result is the lie this branch exists to avoid.
    expect(u.note).toBeNull();
  });

  it("already running with nothing yet: watch that job — one charge, the same job", () => {
    expect(
      afterGenerate({ jobId: id(700), status: "already_running", assets: [] }),
    ).toEqual({
      state: "making",
      jobId: id(700),
      note: null,
    });
  });

  it("already running whose job has finished: the result", () => {
    expect(
      afterGenerate({
        jobId: id(700),
        status: "already_running",
        assets: [a("u")],
      }).state,
    ).toBe("made");
  });

  it("succeeded with nothing to show says so rather than an empty frame", () => {
    const u = afterGenerate({
      jobId: id(700),
      status: "succeeded",
      assets: [a(null)],
    });
    expect(u.state).toBe("made");
    expect(u.note).toMatch(/nothing came back/);
  });

  it("a network failure is lost, not failed — the run may be going, and she must not pay twice", () => {
    expect(generateFailure(new TypeError("Failed to fetch"))).toEqual({
      kind: "lost",
    });
    expect(generateFailure(new TypeError("Network request failed"))).toEqual({
      kind: "lost",
    });
  });

  it("an HTTP failure is the server's sentence", () => {
    expect(generateFailure(new Error("That cost check expired"))).toEqual({
      kind: "failed",
      note: "That cost check expired",
    });
    expect(generateFailure("??")).toEqual({
      kind: "failed",
      note: "Something went wrong making this.",
    });
  });
});

describe("a lost run, found again", () => {
  it("a spent preview is a run to watch — it may well be making", () => {
    expect(
      recoverLost(
        plan(id(2), {
          state: "making",
          run: { jobId: id(700), state: "making", outputIds: [] },
        }),
      ),
    ).toEqual({ state: "making", jobId: id(700), note: null });
    expect(
      recoverLost(
        plan(id(2), {
          state: "made",
          run: { jobId: id(701), state: "made", outputIds: [] },
        }),
      ).jobId,
    ).toBe(id(701));
  });

  it("an unspent preview never reached the run — say so, and Check again", () => {
    const r = recoverLost(plan(id(2), { state: "checked" }));
    expect(r.state).toBe("failed");
    expect(r.note).toMatch(/didn't go through/);
  });

  it("no entry, a failed read, or a swept preview: we don't know, and say where to look", () => {
    expect(recoverLost(null)).toEqual({
      state: "stalled",
      jobId: null,
      note: LOST_NOTE,
    });
    expect(recoverLost("error").note).toBe(LOST_NOTE);
    expect(
      recoverLost(plan(id(2), { state: "gone", preview: null })).state,
    ).toBe("stalled");
  });
});

describe("the watch (resume)", () => {
  const read = (status: string): JobRead => ({
    status,
    startedAt: null,
    assets: [],
  });
  const t0 = 1_000_000;

  it("stops on a terminal state", () => {
    expect(pollOutcome(read("succeeded"), t0, t0 + 1)).toBe("made");
    expect(pollOutcome(read("failed"), t0, t0 + 1)).toBe("failed");
    expect(pollOutcome(read("canceled"), t0, t0 + 1)).toBe("failed");
  });

  it("stops on a job it cannot read — asking again will not change a 404", () => {
    expect(pollOutcome("missing", t0, t0 + 1)).toBe("stalled");
  });

  it("keeps asking while the job runs, and through a failed read", () => {
    expect(pollOutcome(read("running"), t0, t0 + STALL_AFTER_MS - 1)).toBe(
      "continue",
    );
    expect(pollOutcome(read("pending"), t0, t0 + 3_000)).toBe("continue");
    expect(pollOutcome("error", t0, t0 + 3_000)).toBe("continue");
  });

  it("stops after ten minutes of watching, whatever the job says", () => {
    expect(STALL_AFTER_MS).toBe(600_000);
    expect(pollOutcome(read("running"), t0, t0 + STALL_AFTER_MS)).toBe(
      "stalled",
    );
    expect(pollOutcome("error", t0, t0 + STALL_AFTER_MS)).toBe("stalled");
  });

  it("watches every history run the server says is making, and nothing else", () => {
    const run = (state: "making" | "made" | "failed" | "stalled") => ({
      jobId: id(700 + seq),
      state,
      outputIds: [],
    });
    const items = toHistory(
      [
        page([
          plan(id(2), { state: "making", run: run("making") }),
          plan(id(3), { state: "stalled", run: run("stalled") }),
          plan(id(4), { state: "made", run: run("made") }),
          plan(id(5), { state: "checked" }),
          plan(id(6), { state: "making", run: run("making") }),
          plan(id(7), { state: "making", run: null }),
        ]),
      ],
      new Set(),
    ).items;
    const watched = runsToWatch(items, {
      [id(6)]: { state: "made", outputs: [] },
    });
    expect(watched.map((w) => w.entryId)).toEqual([id(2)]);
  });
});

// ─── The composer ──────────────────────────────────────────────────────────────────────────────────────

describe("continuation: an empty tray's next send edits the thread's last image", () => {
  const out = (
    assetId: string,
    over: Partial<{
      uri: string | null;
      editable: boolean;
      removed: boolean;
    }> = {},
  ) => ({
    assetId,
    mediaType: "IMAGE",
    uri: `https://signed.example/${assetId}`,
    removed: false,
    editable: true,
    rejected: false,
    ...over,
  });
  const card = (
    state: "made" | "making" | "checked" | "failed",
    outputs: ReturnType<typeof out>[] = [],
  ) => ({ state, outputs });

  it("defaults to the newest image the thread made — the last of the latest made plan", () => {
    const cards = [
      card("made", [out(id(301))]),
      card("checked"),
      card("made", [out(id(302)), out(id(303))]),
    ];
    expect(continuationFrame(cards, [], null)).toEqual({
      assetId: id(303),
      uri: `https://signed.example/${id(303)}`,
    });
  });

  it("never with anything in the tray — what she attached is her say, and is never added to", () => {
    const cards = [card("made", [out(id(301))])];
    expect(
      continuationFrame(cards, [tray("product", PRODUCT)], null),
    ).toBeNull();
    expect(
      continuationFrame(cards, [tray("source-frame", PHOTO)], null),
    ).toBeNull();
  });

  it("passes over what isn't an image she can still edit, and a plan still making, for the one before", () => {
    const cards = [
      card("made", [out(id(301))]),
      card("made", [
        out(id(302), { removed: true, editable: false, uri: null }),
      ]),
      card("made", [out(id(304), { editable: false })]), // a video: nothing to edit
      card("making"),
      card("failed"),
    ];
    expect(continuationFrame(cards, [], null)?.assetId).toBe(id(301));
  });

  it("nothing to continue from — no made image in the thread — is no default", () => {
    expect(continuationFrame([], [], null)).toBeNull();
    expect(
      continuationFrame([card("checked"), card("making")], [], null),
    ).toBeNull();
  });

  it("declined (the ×) is a fresh send — nothing older stands in for the image she said no to", () => {
    const cards = [card("made", [out(id(301))]), card("made", [out(id(302))])];
    expect(continuationFrame(cards, [], id(302))).toBeNull();
    // A new image lands: the old refusal no longer covers it.
    expect(
      continuationFrame([...cards, card("made", [out(id(303))])], [], id(302))
        ?.assetId,
    ).toBe(id(303));
  });

  it("puts the image in the tray exactly as Edit this does — same frame, same role, no question", () => {
    const frame = continuationFrame([card("made", [out(id(301))])], [], null)!;
    expect(editFromChat([], frame)).toEqual({
      tray: [
        {
          id: `source-frame:${id(301)}`,
          role: "source-frame",
          name: "Your media",
          uri: `https://signed.example/${id(301)}`,
          assetId: id(301),
        },
      ],
      frameAssetId: id(301),
    });
  });
});

describe("edit this", () => {
  it("puts the image in the tray as hers and makes it THE frame — no question, even over a frame she marked", () => {
    const before = [tray("source-frame", PHOTO)];
    const out = editFromChat(before, {
      assetId: OUTPUT,
      uri: "https://signed.example/o",
    });
    expect(out.frameAssetId).toBe(OUTPUT);
    expect(out.tray.map((a) => [a.role, a.assetId])).toEqual([
      ["source-frame", PHOTO],
      ["source-frame", OUTPUT],
    ]);
    // Attaching from the library never moves a mark; only a tap does. (Sending this tray — a marked frame beside
    // another photo of hers — asks first: the frame ask, createAnythingLogic.)
    expect(nextFrameAssetId(out.tray, PHOTO)).toBe(PHOTO);
  });

  it("marks a photo already in the tray rather than adding it twice", () => {
    const before = [tray("source-frame", PHOTO), tray("source-frame", OUTPUT)];
    const out = editFromChat(before, { assetId: PHOTO, uri: null });
    expect(out.tray).toBe(before);
    expect(out.frameAssetId).toBe(PHOTO);
  });

  it("the same photo as a product is still added as hers — the role is what the tap says", () => {
    const out = editFromChat([tray("product", PRODUCT)], {
      assetId: PRODUCT,
      uri: "u",
    });
    expect(out.tray.map((a) => a.role)).toEqual(["product", "source-frame"]);
    expect(out.frameAssetId).toBe(PRODUCT);
  });
});

describe("not what I meant", () => {
  it("puts her sentence back, with the photos it was about", () => {
    const refused = job({
      attachments: [tray("product", PRODUCT), tray("source-frame", PHOTO)],
      frameAssetId: PHOTO,
    });
    const out = composerAfterReject(
      { draft: "", tray: [], frameAssetId: null },
      refused,
    );
    expect(out.draft).toBe("make the sky pink");
    expect(out.tray).toEqual(refused.attachments);
    expect(out.frameAssetId).toBe(PHOTO);
  });

  it("a job with no frame comes back with no frame — no photo of hers is re-marked (frame defaulting)", () => {
    const refused = job({
      prompt: "generate pic of me playing soccer",
      attachments: [tray("source-frame", PHOTO), tray("source-frame", OUTPUT)],
      frameAssetId: null,
    });
    const out = composerAfterReject(
      { draft: "", tray: [], frameAssetId: null },
      refused,
    );
    expect(out.tray).toEqual(refused.attachments);
    expect(out.frameAssetId).toBeNull();
  });

  it("never overwrites what she has put there since", () => {
    const mine = [tray("object", PRODUCT)];
    const out = composerAfterReject(
      { draft: "something new", tray: mine, frameAssetId: null },
      job(),
    );
    expect(out.draft).toBe("something new");
    expect(out.tray).toBe(mine);
    expect(out.frameAssetId).toBeNull();
  });
});

// ─── The threads list ──────────────────────────────────────────────────────────────────────────────────

describe("a row's time", () => {
  const now = Date.parse("2026-09-15T12:00:00.000Z");
  it("reads the way a chat list does", () => {
    expect(relativeTime("2026-09-15T11:59:40.000Z", now)).toBe("just now");
    expect(relativeTime("2026-09-15T11:55:00.000Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-09-15T09:00:00.000Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-14T11:00:00.000Z", now)).toBe("yesterday");
    expect(relativeTime("2026-09-12T12:00:00.000Z", now)).toBe("3 days ago");
  });

  it("never prints the raw timestamp, and says nothing for one it cannot read", () => {
    expect(relativeTime("2026-08-01T12:00:00.000Z", now)).not.toMatch(
      /2026-08-01T/,
    );
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("livePlanView — the generate teaching line (wave C card 2)", () => {
  // The describe above keeps its own `sheet`; this one needs the same shape, so it declares it rather
  // than reaching into another block's scope.
  const sheet = {
    previewId: id(800),
    canGenerate: true,
    jobCostUsd: 0.13,
    unpriced: false,
    blockers: [] as string[],
    interpretation: null,
    card: null,
  };
  const view = (j: SheetJob) =>
    livePlanView(livePlanFrom(id(2), j, sheet), {
      collapsed: new Set(),
      mediaTypes: {},
    });

  it("says it on a GENERATE she attached a photo of herself to", () => {
    // The case the line exists for. Frame defaulting made it the ordinary one: an unmarked photo of
    // hers is her likeness for a new image, so the commonest send silently picks the branch she was
    // never asked about. Both branches are legitimate; nothing said which was happening.
    expect(
      view(
        job({ frameAssetId: null, attachments: [tray("source-frame", PHOTO)] }),
      ).teaching,
    ).toBe(
      "This makes a new image. Your photo is a reference for how you look — tap it to edit that photo instead.",
    );
  });

  it("says NOTHING on an edit — the photo is being changed, which is what she asked for", () => {
    expect(view(job()).teaching).toBeNull();
  });

  it("says nothing on a generate with no photo of hers: there is no misreading available", () => {
    // With nothing of hers attached there is no thumbnail that could have been edited instead, so
    // "tap it to edit that photo" would point at nothing.
    expect(
      view(job({ frameAssetId: null, attachments: [tray("product", PRODUCT)] }))
        .teaching,
    ).toBeNull();
  });

  it("says nothing on a generate whose only photo of hers is still uploading", () => {
    // No assetId yet means nothing was sent and nothing is tappable.
    expect(
      view(
        job({
          frameAssetId: null,
          attachments: [{ ...tray("source-frame", PHOTO), assetId: null }],
        }),
      ).teaching,
    ).toBeNull();
  });

  it("is NULL on a history card, where the tray it points at no longer exists", () => {
    // The line ends "tap it to edit that photo instead". In history the strip is a record of what the
    // plan was built from, not a composer she can still change, so the advice is stale by construction.
    const entry = {
      id: id(2),
      kind: "plan" as const,
      state: "made" as const,
      promptEntryId: id(1),
      sent: [{ assetId: PHOTO, role: "source-frame" }],
      preview: null,
      run: { outputIds: [] },
    };
    expect(
      historyPlanView(entry as never, {
        assets: {},
        prompts: new Map(),
        collapsed: new Set(),
      }).teaching,
    ).toBeNull();
  });
});

// ─── The second pipeline's read ─────────────────────────────────────────────────────────────────

describe("jobReadFromStitch", () => {
  const wire = (over: Record<string, unknown> = {}) =>
    ({
      stitchId: "s1",
      status: "succeeded",
      error: null,
      startedAt: "2026-09-19T00:00:00.000Z",
      completedAt: null,
      asset: {
        assetId: "a1",
        mediaType: "VIDEO",
        url: "https://signed.test/out.mp4",
        approvalStatus: "draft",
      },
      ...over,
    }) as any;

  it("turns ONE file into a list of one, and keeps everything else", () => {
    // The whole adapter. A stitch produces exactly one file, so its route says `asset`; the watch
    // downstream expects `assets`. Normalising HERE is what leaves videoEntryLogic.ts untouched.
    expect(jobReadFromStitch(wire())).toEqual({
      status: "succeeded",
      startedAt: "2026-09-19T00:00:00.000Z",
      assets: [
        {
          assetId: "a1",
          mediaType: "VIDEO",
          url: "https://signed.test/out.mp4",
          approvalStatus: "draft",
        },
      ],
    });
  });

  it("answers an empty list — never null — while there is no file yet", () => {
    // `queued` and `running` both arrive with asset null, and a null `assets` would be a crash in
    // every consumer that maps it.
    expect(
      jobReadFromStitch(wire({ status: "queued", asset: null })).assets,
    ).toEqual([]);
  });

  it("feeds pollOutcome and pollProgress unchanged, because the vocabularies match", () => {
    // 0057's status CHECK is queued | running | succeeded | failed | canceled — exactly the words
    // pollOutcome already branches on. That is why a second pipeline is an adapter, not a rewrite.
    const now = Date.now();
    for (const [status, expected] of [
      ["succeeded", "made"],
      ["failed", "failed"],
      ["canceled", "failed"],
    ] as const) {
      expect(
        pollOutcome(jobReadFromStitch(wire({ status })), now, now, "stitch"),
      ).toBe(expected);
    }
    expect(
      pollOutcome(
        jobReadFromStitch(wire({ status: "queued" })),
        now,
        now,
        "stitch",
      ),
    ).toBe("continue");
    expect(pollProgress(jobReadFromStitch(wire({ status: "queued" })))).toBe(
      "queued",
    );
    expect(pollProgress(jobReadFromStitch(wire({ status: "running" })))).toBe(
      "running",
    );
  });
});

describe("the result player's source", () => {
  const wireAsset = {
    assetId: "a1",
    mediaType: "VIDEO",
    url: "https://signed.test/stitch/output.mp4",
    approvalStatus: "draft",
  };

  it("carries the asset's VIDEO url through, never a poster or a thumb", () => {
    // ⚠️ Asked for as a revert check on the display round: the RESULT must always play the actual
    // stitched mp4 and never fall back to a poster. It holds by construction rather than by a
    // branch — the stitch route's `asset` carries exactly one url, the signed mp4, and there is no
    // thumb anywhere in this shape for anything to prefer.
    const read = jobReadFromStitch({
      stitchId: "s1",
      status: "succeeded",
      error: null,
      startedAt: null,
      completedAt: null,
      asset: wireAsset,
    } as any);

    expect(read.assets).toHaveLength(1);
    expect(read.assets[0].url).toBe(wireAsset.url);
    // There is no `thumbUrl` / `posterUrl` in this path at all — so the player cannot choose one.
    expect(Object.keys(read.assets[0]).sort()).toEqual([
      "approvalStatus",
      "assetId",
      "mediaType",
      "url",
    ]);
  });

  it("becomes an OutputView whose uri is that same url", () => {
    // What VideoEntry hands ClipPlayer. `outputFromRun` is the only constructor on this path.
    const out = outputFromRun(wireAsset);
    expect(out.uri).toBe(wireAsset.url);
    expect(out.removed).toBe(false);
    expect(out.mediaType).toBe("VIDEO");
  });

  it("renders as MISSING rather than as a poster when there is no url", () => {
    // The only fallback that exists, and it is deliberately not an image: a removed asset shows
    // "No clip", not a still of something else.
    const out = outputFromRun({ ...wireAsset, url: null });
    expect(out.uri).toBeNull();
    expect(out.removed).toBe(true);
  });
});

describe("watchLimitMs", () => {
  it("gives a stitch the video clock, not the image one", () => {
    // Server worst case is maxAttempts (3) × leaseMs (20 min) = SIXTY minutes against this thirty,
    // so a stitch on its third handoff outlives the watch while still alive. That is what
    // VideoEntryPhase.unknown is for — "we stopped being able to tell" — and showing `failed`
    // there would be a lie. A watch that cannot end is the leak this whole mechanism prevents.
    expect(watchLimitMs("stitch")).toBe(watchLimitMs("video"));
    expect(watchLimitMs("stitch")).toBeGreaterThan(watchLimitMs("image"));
  });

  it("leaves the default alone, so every caller that predates video is unchanged", () => {
    expect(watchLimitMs()).toBe(watchLimitMs("image"));
  });
});
