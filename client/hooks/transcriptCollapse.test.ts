/**
 * transcriptCollapse — pure-function unit tests (no React, no RN, no room).
 *
 * Covers the rule that decides which line a live transcript update belongs to:
 *   - pyramid collapse: growing partials on separate streams render ONE line
 *   - late-close rewind: an earlier stream closing last cannot shorten the line
 *   - the "yes" / "yes please" boundary the prefix rule deliberately risks
 *   - the identical-repeat collapse the old rule existed for (regression guard)
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/hooks --runInBand
 */

import {
  continuesUtterance,
  createTranscriptTracker,
  isStrictWordPrefix,
  planTranscriptUpdate,
  USER_TRANSCRIPT_PARTIAL_MS,
  type TranscriptInput,
  type TranscriptPlan,
  type TranscriptRole,
  type TranscriptTracker,
} from "./transcriptCollapse";

const T0 = 1_000_000; // fixed clock; every test states its own offsets

/**
 * A tiny stand-in for the message list, so a test can assert what the athlete
 * would actually be looking at rather than reading plans back.
 */
class Screen {
  lines: {
    id: string;
    role: TranscriptRole;
    content: string;
    streaming: boolean;
  }[] = [];
  tx: TranscriptTracker = createTranscriptTracker();
  private nextId = 0;

  /** Feed one update at `now`, apply the plan exactly as the hook does. */
  feed(update: TranscriptInput, now: number): TranscriptPlan {
    const plan = planTranscriptUpdate(
      this.tx,
      update,
      now,
      (role) => `${role === "user" ? "u" : "a"}-${++this.nextId}`,
    );
    if (plan.kind === "update") {
      this.lines = this.lines.map((l) =>
        l.id === plan.id
          ? {
              ...l,
              content: plan.content ?? l.content,
              streaming: plan.streaming,
            }
          : l,
      );
    } else if (plan.kind === "append") {
      this.lines = [
        ...this.lines,
        {
          id: plan.id,
          role: plan.role,
          content: plan.content,
          streaming: plan.streaming,
        },
      ];
    }
    return plan;
  }

  get texts() {
    return this.lines.map((l) => l.content);
  }
}

const user = (
  streamId: string,
  text: string,
  done = false,
): TranscriptInput => ({
  streamId,
  role: "user",
  text,
  done,
});

// ─── The pyramid ──────────────────────────────────────────────────────────────

describe("growing partials collapse to one line", () => {
  it("renders ONE line for 'draft' → 'draft a' → 'draft a reply'", () => {
    const s = new Screen();
    // Each partial is its OWN stream — this is the bug's shape. Before the fix
    // each one appended, and the athlete watched their sentence stack up.
    s.feed(user("s1", "draft"), T0);
    s.feed(user("s2", "draft a"), T0 + 300);
    s.feed(user("s3", "draft a reply"), T0 + 600);

    expect(s.lines).toHaveLength(1);
    expect(s.texts).toEqual(["draft a reply"]);
  });

  it("settles on the final transcript when the last stream closes", () => {
    const s = new Screen();
    s.feed(user("s1", "draft"), T0);
    s.feed(user("s2", "draft a reply"), T0 + 400);
    s.feed(user("s2", "draft a reply", true), T0 + 700);

    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].content).toBe("draft a reply");
    expect(s.lines[0].streaming).toBe(false);
  });

  it("tracks the growth in place rather than pinning the first partial", () => {
    // The regression the fall-through exists to prevent: adopting the line but
    // returning early leaves it reading "draft" for the whole utterance.
    const s = new Screen();
    s.feed(user("s1", "draft"), T0);
    expect(s.texts).toEqual(["draft"]);
    s.feed(user("s2", "draft a"), T0 + 200);
    expect(s.texts).toEqual(["draft a"]);
  });

  it("collapses across re-casing and punctuation from re-transcription", () => {
    // "draft a" → "Draft a reply." is not a raw prefix; normalization is what
    // keeps it on one line.
    const s = new Screen();
    s.feed(user("s1", "draft a"), T0);
    s.feed(user("s2", "Draft a reply."), T0 + 300);

    expect(s.lines).toHaveLength(1);
    expect(s.texts).toEqual(["Draft a reply."]);
  });
});

// ─── The late close ───────────────────────────────────────────────────────────

describe("a late-closing partial stream cannot rewind the line", () => {
  it("keeps the longer text when an earlier stream closes last", () => {
    const s = new Screen();
    s.feed(user("s1", "draft"), T0);
    s.feed(user("s2", "draft a reply"), T0 + 300);
    // s1's terminal emit lands AFTER s2 already grew the line, still carrying
    // the short text. Taking it would rewind the line as the athlete stops.
    s.feed(user("s1", "draft", true), T0 + 500);

    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].content).toBe("draft a reply");
  });

  it("still lets that late close settle `streaming`", () => {
    const s = new Screen();
    s.feed(user("s1", "draft"), T0);
    s.feed(user("s2", "draft a reply"), T0 + 300);
    s.feed(user("s1", "draft", true), T0 + 500);

    expect(s.lines[0].streaming).toBe(false);
  });

  it("reports the keep-what-is-there decision as content: null", () => {
    const s = new Screen();
    s.feed(user("s1", "draft"), T0);
    s.feed(user("s2", "draft a reply"), T0 + 300);
    const plan = s.feed(user("s1", "draft", true), T0 + 500);

    expect(plan).toEqual({
      kind: "update",
      id: "u-1",
      content: null,
      streaming: false,
    });
  });

  it("does not strand the tracker — the next partial still grows the same line", () => {
    const s = new Screen();
    s.feed(user("s1", "draft"), T0);
    s.feed(user("s2", "draft a reply"), T0 + 300);
    s.feed(user("s1", "draft", true), T0 + 500);
    s.feed(user("s3", "draft a reply to Prime"), T0 + 700);

    expect(s.lines).toHaveLength(1);
    expect(s.texts).toEqual(["draft a reply to Prime"]);
  });
});

// ─── The boundary the prefix rule risks ───────────────────────────────────────

describe('the "yes" / "yes please" boundary', () => {
  it("keeps two turns when the second utterance lands after the partial window", () => {
    const s = new Screen();
    s.feed(user("s1", "yes", true), T0);
    s.feed(user("s2", "yes please", true), T0 + USER_TRANSCRIPT_PARTIAL_MS + 1);

    expect(s.lines).toHaveLength(2);
    expect(s.texts).toEqual(["yes", "yes please"]);
  });

  it("collapses them INSIDE the window — the accepted cost of the prefix rule", () => {
    // Documented deliberately: within 1.5s the two are indistinguishable from a
    // partial and its continuation, and pyramiding every utterance is the worse
    // failure. If this ever flips, it is a decision, not a bug fix.
    const s = new Screen();
    s.feed(user("s1", "yes", true), T0);
    s.feed(user("s2", "yes please", true), T0 + 200);

    expect(s.lines).toHaveLength(1);
    expect(s.texts).toEqual(["yes please"]);
  });

  it("never collapses on a shared word STEM", () => {
    // Word-boundary, not raw startsWith: "drafting" is a different word.
    const s = new Screen();
    s.feed(user("s1", "draft", true), T0);
    s.feed(user("s2", "drafting", true), T0 + 100);

    expect(s.lines).toHaveLength(2);
  });

  it("keeps an unrelated utterance separate however fast it lands", () => {
    const s = new Screen();
    s.feed(user("s1", "draft a reply", true), T0);
    s.feed(user("s2", "what is my score", true), T0 + 50);

    expect(s.lines).toHaveLength(2);
  });
});

// ─── What the old rule was for ────────────────────────────────────────────────

describe("identical re-transcriptions still collapse", () => {
  it("shows one line for the three-identical-streams burst", () => {
    const s = new Screen();
    s.feed(user("s1", "what is my score", true), T0);
    s.feed(user("s2", "what is my score", true), T0 + 120);
    s.feed(user("s3", "what is my score", true), T0 + 240);

    expect(s.lines).toHaveLength(1);
  });

  it("treats a genuine repetition a minute later as its own turn", () => {
    const s = new Screen();
    s.feed(user("s1", "yes", true), T0);
    s.feed(user("s2", "yes", true), T0 + 60_000);

    expect(s.lines).toHaveLength(2);
  });
});

// ─── Everything else the rule still has to do ─────────────────────────────────

describe("the rest of the contract", () => {
  it("grows one assistant line across many deltas on one stream", () => {
    const s = new Screen();
    s.feed(
      { streamId: "a1", role: "assistant", text: "Pulling", done: false },
      T0,
    );
    s.feed(
      { streamId: "a1", role: "assistant", text: "Pulling it", done: false },
      T0 + 100,
    );
    s.feed(
      { streamId: "a1", role: "assistant", text: "Pulling it up", done: true },
      T0 + 200,
    );

    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].content).toBe("Pulling it up");
    expect(s.lines[0].streaming).toBe(false);
  });

  it("never collapses Mila's turn into the athlete's", () => {
    // The continuation rule is user-only: role is checked before any text match.
    const s = new Screen();
    s.feed(user("s1", "draft a reply", true), T0);
    s.feed(
      {
        streamId: "a1",
        role: "assistant",
        text: "draft a reply now",
        done: true,
      },
      T0 + 100,
    );

    expect(s.lines).toHaveLength(2);
    expect(s.lines[1].role).toBe("assistant");
  });

  it("ignores an empty stream", () => {
    const s = new Screen();
    const plan = s.feed(user("s1", "   ", true), T0);

    expect(plan).toEqual({ kind: "ignore" });
    expect(s.lines).toHaveLength(0);
  });

  it("mints ids that cannot collide with a typed turn", () => {
    const s = new Screen();
    s.feed(user("s1", "hello", true), T0);
    s.feed(
      { streamId: "a1", role: "assistant", text: "hi", done: true },
      T0 + 10_000,
    );

    expect(s.lines.map((l) => l.id)).toEqual(["u-1", "a-2"]);
  });
});

// ─── The predicates, directly ─────────────────────────────────────────────────

describe("predicates", () => {
  it.each([
    ["draft", "draft a reply", true],
    ["draft", "drafting", false],
    ["draft a reply", "draft", false],
    ["", "draft", false],
    ["draft", "draft", false],
  ])("isStrictWordPrefix(%p, %p) === %p", (shorter, longer, expected) => {
    expect(isStrictWordPrefix(shorter, longer)).toBe(expected);
  });

  it("holds identical text for the full dedup window, not just the partial one", () => {
    expect(continuesUtterance("yes", "yes", 4_000)).toBe(true);
    expect(continuesUtterance("yes", "yes", 6_000)).toBe(false);
  });

  it("holds a prefix only for the partial window", () => {
    expect(continuesUtterance("yes", "yes please", 1_000)).toBe(true);
    expect(continuesUtterance("yes", "yes please", 2_000)).toBe(false);
  });
});
