/**
 * instagram.test.ts — the four Meta calls, against a fake fetch. NOTHING HERE TOUCHES THE NETWORK:
 * every function under test takes its `fetch`, and this file never names the real one.
 *
 * REVERT CHECKS — each of these reds BY NAME when the line it guards is taken out:
 *
 *   RC-A  remove withTimeout from `call`            → "gives up on a fetch that never answers…"
 *   RC-B  put the token in the query string          → "never puts the token in a URL…"
 *   RC-C  chain the fetch error as `cause`           → "a network failure carries no URL and no token…"
 *   RC-D  treat any 4xx envelope as a refusal        → "Meta's 'try again' arrives as a 400 and is still UNKNOWN…"
 *   RC-E  return the raw id without checking it      → "a 200 with no id is an UNKNOWN outcome, never a success"
 *   RC-F  redactUrl keeps query values               → "redactUrl drops every query value…"
 *
 * All synthetic: no real account id, token, handle or URL appears below.
 */
import {
  CAPTION_MAX_CHARS,
  CONTAINER_STATUS,
  IG_GRAPH_VERSION,
  InstagramPublishError,
  REEL_MAX_BYTES,
  REEL_MIN_SECONDS,
  checkPublishingLimit,
  checkStatus,
  classifyMetaError,
  containerBody,
  createContainer,
  fetchPermalink,
  publish,
  publishBody,
  redactUrl,
  sentenceFor,
  type FetchLike,
  type InstagramDeps,
  type PublishErrorCode,
} from "./instagram";

const TOKEN = "SYNTHETIC-TOKEN-do-not-leak-7f3a";
const IG_ID = "17840000000000001";
const SIGNED =
  "https://storage.googleapis.com/bucket/athletes/a/studio/stitch/j/output.mp4" +
  "?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40p.iam&X-Goog-Signature=deadbeefcafe";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** A fetch that records what it was asked and answers from a script. */
function fake(
  answers: (
    | { status?: number; json: unknown }
    | { throws: Error }
    | { hang: true }
  )[],
): { deps: InstagramDeps; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, ...init });
    const a = answers[calls.length - 1];
    if (!a) throw new Error("fake fetch: no scripted answer for this call");
    if ("throws" in a) return Promise.reject(a.throws);
    if ("hang" in a) return new Promise(() => {});
    const status = a.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(a.json),
    });
  };
  return { deps: { fetch, timeoutMs: 200 }, calls };
}

const metaError = (
  status: number,
  error: Record<string, unknown>,
): { status: number; json: unknown } => ({ status, json: { error } });

async function caught(p: Promise<unknown>): Promise<InstagramPublishError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(InstagramPublishError);
    return e as InstagramPublishError;
  }
  throw new Error("expected a throw");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the four calls send Meta's shapes", () => {
  it("createContainer POSTs a REELS container to her IG id and returns the container id", async () => {
    const { deps, calls } = fake([{ json: { id: "c-1" } }]);
    const out = await createContainer(
      { igUserId: IG_ID, token: TOKEN, videoUrl: SIGNED, caption: "hello" },
      deps,
    );
    expect(out).toEqual({ containerId: "c-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      `https://graph.instagram.com/${IG_GRAPH_VERSION}/${IG_ID}/media`,
    );
    expect(JSON.parse(calls[0].body!)).toEqual({
      media_type: "REELS",
      video_url: SIGNED,
      caption: "hello",
    });
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("the body dry-run prints IS the body that is sent", async () => {
    const { deps, calls } = fake([
      { json: { id: "c-1" } },
      { json: { id: "m-1" } },
    ]);
    const input = { videoUrl: SIGNED, caption: "a caption" };
    await createContainer({ igUserId: IG_ID, token: TOKEN, ...input }, deps);
    await publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps);
    expect(JSON.parse(calls[0].body!)).toEqual(containerBody(input));
    expect(JSON.parse(calls[1].body!)).toEqual(publishBody("c-1"));
  });

  it("checkStatus GETs the container and reads every status Meta documents", async () => {
    for (const statusCode of CONTAINER_STATUS) {
      const { deps, calls } = fake([
        { json: { id: "c-1", status_code: statusCode, status: "x" } },
      ]);
      await expect(
        checkStatus({ containerId: "c-1", token: TOKEN }, deps),
      ).resolves.toEqual({ statusCode, status: "x" });
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url).toBe(
        `https://graph.instagram.com/${IG_GRAPH_VERSION}/c-1?fields=status_code,status`,
      );
      expect(calls[0].body).toBeUndefined();
    }
  });

  /**
   * A status we have never heard of is not FINISHED and is not PUBLISHED. If this returned it as a
   * string the runner could compare it to neither and fall through to "so publish".
   */
  it("checkStatus refuses a status it does not know — the runner must not act on it", async () => {
    for (const json of [
      { status_code: "READY" },
      { status_code: 7 },
      {},
      null,
    ]) {
      const { deps } = fake([{ json }]);
      const e = await caught(
        checkStatus({ containerId: "c-1", token: TOKEN }, deps),
      );
      expect(e.op).toBe("checkStatus");
      expect(e.outcomeUnknown).toBe(true);
    }
  });

  it("publish POSTs creation_id to media_publish and returns the media id", async () => {
    const { deps, calls } = fake([{ json: { id: "m-1" } }]);
    await expect(
      publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps),
    ).resolves.toEqual({ mediaId: "m-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      `https://graph.instagram.com/${IG_GRAPH_VERSION}/${IG_ID}/media_publish`,
    );
    expect(JSON.parse(calls[0].body!)).toEqual({ creation_id: "c-1" });
  });

  it("publish makes exactly ONE request — it never retries by itself", async () => {
    const { deps, calls } = fake([
      metaError(500, { message: "boom", code: 2 }),
      { json: { id: "m-2" } },
    ]);
    await caught(
      publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps),
    );
    expect(calls).toHaveLength(1);
  });

  it("fetchPermalink returns the link, or null when Meta answers without one", async () => {
    const a = fake([
      { json: { permalink: "https://example.test/reel/1", id: "m-1" } },
    ]);
    await expect(
      fetchPermalink({ mediaId: "m-1", token: TOKEN }, a.deps),
    ).resolves.toBe("https://example.test/reel/1");
    expect(a.calls[0].url).toBe(
      `https://graph.instagram.com/${IG_GRAPH_VERSION}/m-1?fields=permalink`,
    );
    for (const json of [{ id: "m-1" }, { permalink: "" }, { permalink: 5 }]) {
      const b = fake([{ json }]);
      await expect(
        fetchPermalink({ mediaId: "m-1", token: TOKEN }, b.deps),
      ).resolves.toBeNull();
    }
  });

  it("checkPublishingLimit reads Meta's quota, and an unfamiliar body is nulls — never a throw, never a guess", async () => {
    const a = fake([
      {
        json: {
          data: [
            {
              quota_usage: 2,
              config: { quota_total: 50, quota_duration: 86400 },
            },
          ],
        },
      },
    ]);
    await expect(
      checkPublishingLimit({ igUserId: IG_ID, token: TOKEN }, a.deps),
    ).resolves.toEqual({ used: 2, total: 50 });
    expect(a.calls[0].method).toBe("GET");
    expect(a.calls[0].url).toBe(
      `https://graph.instagram.com/${IG_GRAPH_VERSION}/${IG_ID}/content_publishing_limit?fields=quota_usage,config`,
    );
    expect(a.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);

    for (const json of [
      {},
      { data: [] },
      { data: [{ quota_usage: "2" }] },
      null,
    ]) {
      const b = fake([{ json }]);
      await expect(
        checkPublishingLimit({ igUserId: IG_ID, token: TOKEN }, b.deps),
      ).resolves.toEqual({ used: null, total: null });
    }
  });

  /** The reason it exists: a token that cannot post is refused here, before any container. */
  it("checkPublishingLimit turns Meta's permission refusal into 'reconnect'", async () => {
    const { deps } = fake([
      metaError(400, {
        code: 10,
        type: "OAuthException",
        message: "no permission",
      }),
    ]);
    const e = await caught(
      checkPublishingLimit({ igUserId: IG_ID, token: TOKEN }, deps),
    );
    expect(e.code).toBe("reconnect");
    expect(e.outcomeUnknown).toBe(false);
    expect(e.userMessage).toBe("Reconnect Instagram to allow posting.");
  });

  it("an id is a path segment, never a path — a slash in one cannot reach another node", async () => {
    const { deps, calls } = fake([{ json: { id: "m-1" } }]);
    await publish({ igUserId: "1/../2", containerId: "c", token: TOKEN }, deps);
    expect(calls[0].url).toBe(
      `https://graph.instagram.com/${IG_GRAPH_VERSION}/1%2F..%2F2/media_publish`,
    );
  });
});

describe("the token", () => {
  /** RC-B. */
  it("never puts the token in a URL — it travels as a Bearer header on all four calls", async () => {
    const { deps, calls } = fake([
      { json: { id: "c-1" } },
      { json: { status_code: "FINISHED" } },
      { json: { id: "m-1" } },
      { json: { permalink: "https://example.test/reel/1" } },
    ]);
    await createContainer(
      { igUserId: IG_ID, token: TOKEN, videoUrl: SIGNED, caption: "" },
      deps,
    );
    await checkStatus({ containerId: "c-1", token: TOKEN }, deps);
    await publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps);
    await fetchPermalink({ mediaId: "m-1", token: TOKEN }, deps);

    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.url).not.toMatch(/access_token/i);
      expect(c.body ?? "").not.toContain(TOKEN);
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });
});

describe("a throw is not a 'no'", () => {
  /** RC-A. The test's own timeout is the detector: without withTimeout this never settles. */
  it("gives up on a fetch that never answers, and calls the outcome UNKNOWN", async () => {
    const { deps, calls } = fake([{ hang: true }]);
    const started = Date.now();
    const e = await caught(
      publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(e.op).toBe("publish");
    expect(e.code).toBe("transient");
    expect(e.outcomeUnknown).toBe(true);
    // The socket is released too, for a fetch that honours its signal.
    expect(calls[0].signal?.aborted).toBe(true);
  }, 5_000);

  it("gives up on a BODY that never arrives — headers alone are not an answer", async () => {
    const deps: InstagramDeps = {
      timeoutMs: 200,
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise(() => {}),
        }),
    };
    const e = await caught(
      publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps),
    );
    expect(e.outcomeUnknown).toBe(true);
  }, 5_000);

  /** RC-C. undici puts the URL in some failures; a signed URL or a token must not ride out on one. */
  it("a network failure carries no URL and no token — not in the message, the detail or the cause", async () => {
    const { deps } = fake([
      {
        throws: new Error(
          `fetch failed: ${SIGNED} Authorization: Bearer ${TOKEN}`,
        ),
      },
    ]);
    const e = await caught(
      createContainer(
        { igUserId: IG_ID, token: TOKEN, videoUrl: SIGNED, caption: "" },
        deps,
      ),
    );
    expect(e.outcomeUnknown).toBe(true);
    const everything = JSON.stringify({
      message: e.message,
      detail: e.detail,
      cause: String((e as { cause?: unknown }).cause ?? ""),
      stack: e.stack,
    });
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("X-Goog-Signature");
    expect(everything).not.toContain("deadbeefcafe");
    expect((e as { cause?: unknown }).cause).toBeUndefined();
  });

  it("a 5xx is UNKNOWN even when it carries an envelope", async () => {
    const { deps } = fake([metaError(500, { message: "x", code: 190 })]);
    const e = await caught(
      publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps),
    );
    expect(e.outcomeUnknown).toBe(true);
  });

  it("a failure with no envelope is UNKNOWN", async () => {
    for (const a of [
      { status: 400, json: {} },
      { status: 502, json: "<html>" },
      { status: 400, json: null },
    ]) {
      const { deps } = fake([a]);
      const e = await caught(
        publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps),
      );
      expect(e.outcomeUnknown).toBe(true);
      expect(e.code).toBe("transient");
    }
  });

  /** RC-D. Meta's own retry codes are documented as HTTP 400. The status alone proves nothing. */
  it("Meta's 'try again' arrives as a 400 and is still UNKNOWN — so is a refusal we do not recognise", async () => {
    for (const error of [
      { code: -1, error_subcode: 2207001, message: "server error" },
      { code: -1, error_subcode: 2207032, message: "Create media fail" },
      { code: 1, is_transient: true, message: "temporarily unavailable" },
      { code: 99999, message: "something new" },
    ]) {
      const { deps } = fake([metaError(400, error)]);
      const e = await caught(
        publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps),
      );
      expect(e.outcomeUnknown).toBe(true);
    }
  });

  it("an explicit refusal we recognise IS a 'no' — nothing was posted", async () => {
    for (const error of [
      { code: 190, type: "OAuthException", message: "token expired" },
      { code: 9, error_subcode: 2207042, message: "limit" },
      { code: 9007, error_subcode: 2207027, message: "not ready" },
      { code: 352, error_subcode: 2207026, message: "format" },
    ]) {
      const { deps } = fake([metaError(400, error)]);
      const e = await caught(
        publish({ igUserId: IG_ID, containerId: "c-1", token: TOKEN }, deps),
      );
      expect(e.outcomeUnknown).toBe(false);
    }
  });

  /** RC-E. */
  it("a 200 with no id is an UNKNOWN outcome, never a success", async () => {
    for (const json of [{}, { id: "" }, { id: 12 }, { success: true }, null]) {
      for (const op of [
        () =>
          publish(
            { igUserId: IG_ID, containerId: "c-1", token: TOKEN },
            fake([{ json }]).deps,
          ),
        () =>
          createContainer(
            { igUserId: IG_ID, token: TOKEN, videoUrl: SIGNED, caption: "" },
            fake([{ json }]).deps,
          ),
      ]) {
        const e = await caught(op());
        expect(e.outcomeUnknown).toBe(true);
      }
    }
  });
});

describe("Meta's numbers become what she can do next", () => {
  const ROWS: [string, Record<string, unknown>, PublishErrorCode][] = [
    ["unsupported format", { code: 352, error_subcode: 2207026 }, "restitch"],
    [
      "could not fetch the uri",
      { code: 9004, error_subcode: 2207052 },
      "fetch_failed",
    ],
    [
      "took too long to download",
      { code: -2, error_subcode: 2207003 },
      "fetch_failed",
    ],
    ["daily limit", { code: 9, error_subcode: 2207042 }, "rate_limited"],
    ["spam restriction", { code: 4, error_subcode: 2207051 }, "rate_limited"],
    ["container expired", { code: -2, error_subcode: 2207020 }, "expired"],
    [
      "container does not exist",
      { code: 24, error_subcode: 2207008 },
      "expired",
    ],
    ["not ready", { code: 9007, error_subcode: 2207027 }, "not_ready"],
    [
      "media not found = permission",
      { code: 24, error_subcode: 2207006 },
      "reconnect",
    ],
    ["invalid token", { code: 190 }, "reconnect"],
    ["permission denied", { code: 10 }, "reconnect"],
    ["missing permission", { code: 200 }, "reconnect"],
    [
      "permission by type",
      { code: 1, type: "INSTAGRAM_PLATFORM_API__PERMISSION" },
      "reconnect",
    ],
    ["server error", { code: -1, error_subcode: 2207001 }, "transient"],
    ["re-create media", { code: -1, error_subcode: 2207032 }, "transient"],
    ["flagged transient", { code: 2, is_transient: true }, "transient"],
    ["never seen it", { code: 31337 }, "unknown"],
  ];

  it.each(ROWS)("%s", (_name, envelope, expected) => {
    expect(classifyMetaError(envelope)).toBe(expected);
  });

  /** -2 means both "expired" and "slow download"; -1 both "server error" and "re-create". The subcode decides. */
  it("reads the SUBCODE before the code — Meta reuses codes across unrelated failures", () => {
    expect(classifyMetaError({ code: -2, error_subcode: 2207003 })).toBe(
      "fetch_failed",
    );
    expect(classifyMetaError({ code: -2, error_subcode: 2207020 })).toBe(
      "expired",
    );
    // A permission CODE with a format SUBCODE is a format problem.
    expect(classifyMetaError({ code: 200, error_subcode: 2207026 })).toBe(
      "restitch",
    );
  });

  /**
   * The ratified requirement: the re-stitch suggestion has to REACH her. A raw Meta code is not an
   * instruction, and Meta's own sentence ("The video format is not supported.") tells her nothing
   * she can do inside this app.
   */
  it("she reads OUR sentence, never Meta's — and the format refusal tells her to put it together again", async () => {
    const { deps } = fake([
      metaError(400, {
        code: 352,
        error_subcode: 2207026,
        message: "The video format is not supported.",
        fbtrace_id: "trace-1",
      }),
    ]);
    const e = await caught(
      createContainer(
        { igUserId: IG_ID, token: TOKEN, videoUrl: SIGNED, caption: "" },
        deps,
      ),
    );
    expect(e.code).toBe("restitch");
    expect(e.userMessage).toMatch(/put it together again/i);
    expect(e.userMessage).not.toContain("not supported");
    expect(e.message).toBe(e.userMessage);
    // Meta's words are kept — for the log, where they belong.
    expect(e.detail).toMatchObject({
      httpStatus: 400,
      metaCode: 352,
      metaSubcode: 2207026,
      metaMessage: "The video format is not supported.",
      fbtraceId: "trace-1",
    });
  });

  it("the permission refusal reads exactly 'Reconnect Instagram to allow posting.'", () => {
    expect(sentenceFor("reconnect")).toBe(
      "Reconnect Instagram to allow posting.",
    );
  });

  it("no sentence carries a number, a code or the word Meta", () => {
    const codes: PublishErrorCode[] = [
      "reconnect",
      "restitch",
      "fetch_failed",
      "rate_limited",
      "expired",
      "not_ready",
      "transient",
      "unknown",
    ];
    for (const c of codes) {
      expect(sentenceFor(c)).not.toMatch(/\d{3,}|\bmeta\b|subcode|OAuth/i);
      expect(sentenceFor(c).length).toBeGreaterThan(20);
    }
  });
});

describe("what Meta will take — read from the Reels spec", () => {
  it("pins the limits the route refuses on", () => {
    expect(CAPTION_MAX_CHARS).toBe(2200);
    expect(REEL_MIN_SECONDS).toBe(3);
    expect(REEL_MAX_BYTES).toBe(300_000_000);
  });
});

describe("redactUrl", () => {
  /** RC-F. */
  it("redactUrl drops every query value and keeps which object it was", () => {
    const out = redactUrl(SIGNED);
    expect(out).toBe(
      "https://storage.googleapis.com/bucket/athletes/a/studio/stitch/j/output.mp4" +
        "?<redacted: X-Goog-Algorithm,X-Goog-Credential,X-Goog-Signature>",
    );
    expect(out).not.toContain("deadbeefcafe");
    expect(out).not.toContain("svc");
  });

  it("leaves a URL with no query alone, and never throws on junk", () => {
    expect(redactUrl("https://example.test/a/b.mp4")).toBe(
      "https://example.test/a/b.mp4",
    );
    expect(redactUrl("not a url ?sig=secret")).toBe("<unparseable url>");
  });
});
