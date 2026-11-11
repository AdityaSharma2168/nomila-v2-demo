/**
 * probeRedaction.test.ts — a signed URL's credential must not survive into an error message.
 *
 * probeDurationSeconds is the one probe that is handed a URL rather than a local path (the upload
 * route and the poster cron both sign one), and a signed GCS URL carries its credential in the
 * QUERY STRING. Both callers log the error it throws.
 *
 * The trap this pins: ffprobe ECHOES ITS INPUT BACK in stderr. Sanitizing only the argument we
 * passed in looks correct, reads correct, and still leaks — because the copy that reaches the log
 * is the one ffprobe wrote, not the one we handed it.
 *
 * No ffprobe binary is involved: the spawn is stubbed so the stderr can be made to say exactly what
 * a real 403 says.
 */

jest.mock("child_process", () => ({ execFile: jest.fn() }));

import { execFile } from "child_process";
import { probeDurationSeconds, redact } from "./probe";

const execFileMock = execFile as unknown as jest.Mock;

/** A GCS V4 signed URL, shaped like the real thing. Synthetic — no real credential here. */
const SIGNED =
  "https://storage.googleapis.com/bucket/athletes/a/uploads/clip.mp4" +
  "?X-Goog-Algorithm=GOOG4-RSA-SHA256" +
  "&X-Goog-Credential=svc%40project.iam.gserviceaccount.com%2F20260919%2Fauto%2Fstorage%2Fgoog4_request" +
  "&X-Goog-Signature=deadbeefcafe1234567890abcdef";

const SECRETS = ["X-Goog-Signature", "X-Goog-Credential", "deadbeefcafe"];

function ffprobeFails(stderr: string) {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(Object.assign(new Error("Command failed"), { stderr }), null);
    },
  );
}

function ffprobeReturns(stdout: string) {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

beforeEach(() => execFileMock.mockReset());

describe("probeDurationSeconds: the signed URL never survives into an error", () => {
  /**
   * ⚠️  THE REVERT CHECK. This is the exact stderr a 403 on an expired signed URL produces, with
   * the credential echoed back by ffprobe itself.
   *
   * MUTATION: redact `input` alone and concatenate the raw stderr (which is what the first version
   * of this function did). The message then carries X-Goog-Signature in full and this reds.
   */
  it("strips the credential ffprobe echoed back in its own stderr", async () => {
    ffprobeFails(`${SIGNED}: Server returned 403 Forbidden`);

    const err = await probeDurationSeconds(SIGNED).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    for (const secret of SECRETS) {
      expect((err as Error).message).not.toContain(secret);
    }
    // Still useful: the object path and the reason survive, which is what a reader needs.
    expect((err as Error).message).toContain("clip.mp4");
    expect((err as Error).message).toContain("403");
  });

  it("strips it from the unreadable-duration path too", async () => {
    ffprobeReturns(JSON.stringify({ streams: [{}], format: {} }));

    const err = await probeDurationSeconds(SIGNED).catch((e: Error) => e);

    for (const secret of SECRETS) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  /**
   * Truncation runs AFTER redaction. Slicing first would cut a long stderr mid-URL and leave the
   * front half of a signature in the message — shorter, and just as leaked.
   */
  it("redacts before it truncates, so a long stderr cannot smuggle a prefix through", async () => {
    ffprobeFails(`${SIGNED}: ${"x".repeat(2000)}`);

    const err = await probeDurationSeconds(SIGNED).catch((e: Error) => e);

    expect((err as Error).message.length).toBeLessThanOrEqual(400);
    for (const secret of SECRETS) {
      expect((err as Error).message).not.toContain(secret);
    }
    // Not even a fragment of the signature: the whole query string is gone before the cut.
    expect((err as Error).message).not.toMatch(/deadbeef/);
  });
});

describe("redact", () => {
  it("keeps a local path intact — there is no query string to lose", () => {
    expect(redact("/tmp/workspace/clip.mp4")).toBe("/tmp/workspace/clip.mp4");
  });

  it("keeps a URL that carries no credential", () => {
    expect(redact("https://example.com/a/b.mp4")).toBe(
      "https://example.com/a/b.mp4",
    );
  });

  it("strips every URL in a message, not just the first", () => {
    const out = redact(
      `first https://a.test/x.mp4?sig=AAA then https://b.test/y.mp4?sig=BBB`,
    );
    expect(out).not.toContain("AAA");
    expect(out).not.toContain("BBB");
    expect(out).toContain("https://a.test/x.mp4?…");
    expect(out).toContain("https://b.test/y.mp4?…");
  });

  /**
   * The URL is usually followed by more text (`: Server returned 403`), and the match stops at
   * WHITESPACE — so the punctuation welded to the end of the query goes with it. That is the
   * correct direction to be wrong in: a query string has no reserved terminator, so anything
   * narrower risks leaving the tail of a signature behind. The cost is a swallowed colon; the
   * reason for the failure, which is the part a reader needs, survives.
   *
   * Asserted as it behaves rather than as it reads, deliberately. Tightening the pattern to keep
   * the colon would trade a real guarantee for a cosmetic one.
   */
  it("over-redacts punctuation welded to the query, and keeps the reason", () => {
    expect(redact("https://a.test/x.mp4?sig=AAA: Server returned 403")).toBe(
      "https://a.test/x.mp4?… Server returned 403",
    );
  });
});
