/**
 * remotionTransfer.test.ts — the render service's own byte movement (media/remotion/server/transfer.ts), now that it
 * holds no bucket access: only signed storage.googleapis.com URLs, a byte cap on inputs, outputs PUT with the signed
 * content type. Fetch is injected; nothing reaches the network.
 */
import {
  checkRequest, fetchInput, isSignedStorageUrl, MAX_INPUT_BYTES, MAX_INPUTS, putOutput,
} from "../../media/remotion/server/transfer";

const GCS = "https://storage.googleapis.com/nomila-v2-athlete-media/athletes/a/x.jpg?X-Goog-Signature=abc";
const PUT = "https://storage.googleapis.com/nomila-v2-athlete-media/athletes/a/reel.mp4?X-Goog-Signature=def";

const streamOf = (chunks: number[]) => new ReadableStream<Uint8Array>({
  start(c) { for (const n of chunks) c.enqueue(new Uint8Array(n)); c.close(); },
});
const fakeFetch = (res: Partial<Response> & { status?: number }) => jest.fn(async (_u: any, _i?: any) => ({
  ok: (res.status ?? 200) < 300, status: res.status ?? 200, headers: new Headers(), body: null, text: async () => "", ...res,
}) as unknown as Response);

describe("which URLs the service accepts", () => {
  it("only https on exactly storage.googleapis.com", () => {
    expect(isSignedStorageUrl(GCS)).toBe(true);
    for (const bad of [
      "http://storage.googleapis.com/b/o", "https://metadata.google.internal/computeMetadata/v1/", "https://169.254.169.254/",
      "https://storage.googleapis.com.evil.com/b/o", "https://evil.com/storage.googleapis.com/b/o", "https://storage.googleapis.com:8443/b/o",
      "https://user:pw@storage.googleapis.com/b/o", "http://localhost:8080/assets/x", "file:///etc/passwd", "gcs:athletes/a/x.jpg", 42, null,
    ]) expect(isSignedStorageUrl(bad)).toBe(false);
  });

  it("refuses a request with a non-GCS host in the props or the outputs, or an unsigned ref", () => {
    const ok = { composition: "TitleCard", inputProps: { text: "Hi", background: GCS, palette: [], seconds: 2 }, output: { videoPutUrl: PUT } };
    const good = checkRequest(ok);
    expect("error" in good ? good.error : good.inputs).toEqual([GCS]);
    expect(checkRequest({ ...ok, inputProps: { ...ok.inputProps, background: "http://169.254.169.254/latest" } })).toHaveProperty("error");
    expect(checkRequest({ ...ok, inputProps: { ...ok.inputProps, background: "gcs:athletes/a/x.jpg" } })).toHaveProperty("error");
    // What a headless browser would still resolve against http://localhost: protocol-relative, backslashes, padded.
    for (const sneaky of ["//evil.example/x.jpg", "\\\\evil.example/x.jpg", "/\\evil.example/x.jpg", "  https://evil.example/x.jpg", "HTTPS://evil.example/x"]) {
      expect(checkRequest({ ...ok, inputProps: { ...ok.inputProps, background: sneaky } })).toHaveProperty("error");
    }
    // What the WHATWG parser (Chromium's) still resolves to another host: no slashes, control characters, tabs.
    for (const sneaky of ["https:evil.example/x.jpg", "https:/evil.example", "https:\\evil.example", "\u0001https://evil.example/x",
      "\u001f//evil.example", "h\tttps://evil.example/x", "ftp://evil.example/x", "file:///etc/passwd", "ws://evil.example"]) {
      expect([sneaky, checkRequest({ ...ok, inputProps: { ...ok.inputProps, background: sneaky } })]).toEqual([sneaky, expect.objectContaining({ error: expect.any(String) })]);
      expect([sneaky, checkRequest({ ...ok, inputProps: { ...ok.inputProps, text: sneaky } })]).toEqual([sneaky, expect.objectContaining({ error: expect.any(String) })]);
    }
    // A media prop (what <Img> / <Audio> load) is nothing or a signed storage URL: no local path, data: or other scheme.
    for (const local of ["/assets/other-job/0.jpg", "assets/x.jpg", "data:image/png;base64,AA", "blob:x", "javascript:alert(1)", 42]) {
      expect([local, checkRequest({ ...ok, inputProps: { ...ok.inputProps, background: local } })]).toEqual([local, { error: "a media prop is not a signed storage URL" }]);
    }
    const reel = (image: unknown, music: unknown = null) => checkRequest({
      composition: "BrandBookReel", output: { videoPutUrl: PUT },
      inputProps: { firstName: "A", scenes: [{ image, kicker: "K", text: "T" }], palette: [], music, sceneSec: 3, transitionSec: 0.5, outroSec: 2 },
    });
    expect(reel(GCS)).not.toHaveProperty("error");
    expect(reel("/x.jpg")).toHaveProperty("error");
    expect(reel(GCS, "data:audio/mp3;base64,AA")).toHaveProperty("error");
    expect(checkRequest({ ...ok, inputProps: { ...ok.inputProps, extra: Array.from({ length: MAX_INPUTS + 1 }, (_, i) => `${GCS}&n=${i}`) } }))
      .toEqual({ error: "too many inputs" });
    // Plain words are not URLs.
    for (const words of ["Note: game day / 7pm", "https: the best", "game day", "100% / 7pm", "a/b/c", "mailto:me@example.com"]) {
      expect([words, checkRequest({ ...ok, inputProps: { ...ok.inputProps, text: words } })]).toEqual([words, expect.not.objectContaining({ error: expect.anything() })]);
    }
    expect(checkRequest({ ...ok, output: { videoPutUrl: "https://evil.example/put" } })).toHaveProperty("error");
    expect(checkRequest({ ...ok, output: { videoPutUrl: PUT, poster: "athletes/a/p.jpg" } })).toHaveProperty("error");
    expect(checkRequest({ ...ok, output: { videoPutUrl: PUT, posterPutUrl: "https://evil.example/p" } })).toHaveProperty("error");
    expect(checkRequest({ ...ok, composition: "Nope" })).toHaveProperty("error");
  });

  it("never fetches a non-GCS host", async () => {
    const f = fakeFetch({});
    await expect(fetchInput("https://evil.example/x.jpg", { fetchImpl: f })).rejects.toThrow(/host refused/);
    await expect(putOutput("https://evil.example/x.mp4", Buffer.from("v"), "video/mp4", { fetchImpl: f })).rejects.toThrow(/host refused/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("inputs", () => {
  it("reads the body, with no redirects and a timeout", async () => {
    const f = fakeFetch({ body: streamOf([3, 4]) as any });
    expect((await fetchInput(GCS, { fetchImpl: f })).byteLength).toBe(7);
    const init = f.mock.calls[0][1];
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("holds the byte cap: a declared length over it, and a stream that runs past it", async () => {
    const declared = fakeFetch({ headers: new Headers({ "content-length": String(MAX_INPUT_BYTES + 1) }), body: streamOf([1]) as any });
    await expect(fetchInput(GCS, { fetchImpl: declared })).rejects.toThrow(/too large/);
    const streamed = fakeFetch({ body: streamOf([600, 600]) as any });
    await expect(fetchInput(GCS, { fetchImpl: streamed, maxBytes: 1000 })).rejects.toThrow(/too large/);
    expect((await fetchInput(GCS, { fetchImpl: fakeFetch({ body: streamOf([500, 500]) as any }), maxBytes: 1000 })).byteLength).toBe(1000);
  });

  it("fails on a non-2xx (an expired or forged signature)", async () => {
    await expect(fetchInput(GCS, { fetchImpl: fakeFetch({ status: 403 }) })).rejects.toThrow(/403/);
  });
});

describe("outputs", () => {
  it("PUTs the bytes to the given URL with exactly the signed content type", async () => {
    const f = fakeFetch({});
    await putOutput(PUT, Buffer.from("video-bytes"), "video/mp4", { fetchImpl: f });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(PUT);
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "video/mp4" });
    expect(Buffer.from(init.body).toString()).toBe("video-bytes");
    expect(init.redirect).toBe("error");
  });

  it("fails when storage refuses the PUT", async () => {
    await expect(putOutput(PUT, Buffer.from("v"), "video/mp4", { fetchImpl: fakeFetch({ status: 403, text: async () => "SignatureDoesNotMatch" }) }))
      .rejects.toThrow(/403/);
    // Only storage's error code reaches the message (and so the logs), never the echoed canonical request.
    const xml = "<?xml version='1.0'?><Error><Code>SignatureDoesNotMatch</Code><StringToSign>GOOG4-RSA-SHA256 secret-ish</StringToSign></Error>";
    const err = await putOutput(PUT, Buffer.from("v"), "video/mp4", { fetchImpl: fakeFetch({ status: 403, text: async () => xml }) }).catch((e) => e);
    expect(err.message).toBe("output put 403: SignatureDoesNotMatch");
  });
});
