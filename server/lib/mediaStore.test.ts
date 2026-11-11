/**
 * mediaStore.test — rehostFromUrl fetches through safeFetch (PR 7, Lane F2). GCS and the fetch are
 * stubbed; nothing here opens a socket or writes a bucket.
 */
jest.mock("@google-cloud/storage", () => {
  const save = jest.fn(async () => undefined);
  const file = jest.fn(() => ({ save }));
  const bucket = jest.fn(() => ({ file }));
  return { Storage: jest.fn(() => ({ bucket })), __gcs: { save, file, bucket } };
});
jest.mock("./safeFetch", () => ({
  ...jest.requireActual("./safeFetch"),
  safeFetch: jest.fn(),
}));

import { rehostFromUrl } from "./mediaStore";
import { safeFetch } from "./safeFetch";

const gcs = (
  jest.requireMock("@google-cloud/storage") as {
    __gcs: { save: jest.Mock; file: jest.Mock };
  }
).__gcs;
const actualSafeFetch = (jest.requireActual("./safeFetch") as typeof import("./safeFetch")).safeFetch;
const fetched = safeFetch as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("rehostFromUrl", () => {
  /** ⚠️ MUTATION: fetch the url with bare `fetch` — this reds: safeFetch was never asked. */
  it("fetches the url a provider or a CDN chose through safeFetch, and stores what came back", async () => {
    const bytes = Buffer.from("jpeg-bytes");
    fetched.mockResolvedValueOnce(
      new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const out = await rehostFromUrl("https://cdn.example/a?sig=1", "athletes/x/y");

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0][0]).toBe("https://cdn.example/a?sig=1");
    expect(out).toEqual({ gcs_path: "athletes/x/y.jpg", content_type: "image/jpeg", bytes: bytes.length });
    expect(gcs.file).toHaveBeenCalledWith("athletes/x/y.jpg");
    expect(gcs.save).toHaveBeenCalledTimes(1);
  });

  it("an http:// url is refused before anything is fetched — a failed rehost, nothing stored (the F2 behaviour change, pinned)", async () => {
    fetched.mockImplementationOnce(actualSafeFetch); // the real guard: refuses the scheme before any DNS or socket

    const out = await rehostFromUrl("http://cdn.example/a", "athletes/x/z");

    expect(out).toBeNull();
    expect(gcs.save).not.toHaveBeenCalled();
  });

  it("a non-2xx answer is a failed rehost, as before", async () => {
    fetched.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    expect(await rehostFromUrl("https://cdn.example/b", "athletes/x/w")).toBeNull();
    expect(gcs.save).not.toHaveBeenCalled();
  });
});
