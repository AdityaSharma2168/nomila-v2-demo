/**
 * qa/embed — a failed embedding names the photograph it was for (R0.b's follow-up).
 *
 * The embedding endpoint and its auth are the network boundary and are mocked. Only the failure lines are
 * under test: an embedding that does not return is logged with the photo's id, and never throws.
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock("../../logger", () => ({ createLogger: () => mockLogger }));
jest.mock("../../lib/mediaEmbed", () => ({ cosine: jest.fn() }));
jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({
      getAccessToken: async () => ({ token: "synthetic-token" }),
      credentials: { expiry_date: Date.now() + 3_600_000 },
    }),
  })),
}));

import { embedImageBytes } from "./embed";

const realFetch = global.fetch;
beforeEach(() => jest.clearAllMocks());
afterAll(() => {
  global.fetch = realFetch;
});

describe("a failed embedding names its photograph", () => {
  it("a failed embedding logs the photo's id and returns null", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "unavailable",
    })) as unknown as typeof fetch;

    expect(await embedImageBytes(Buffer.from("face"), "ref-2")).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { assetId: "ref-2", status: 503, body: "unavailable" },
      "qa embed failed",
    );
  });

  it("a thrown embedding logs the photo's id and returns null", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    expect(await embedImageBytes(Buffer.from("face"), "ref-2")).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { assetId: "ref-2", error: "socket hang up" },
      "qa embed threw",
    );
  });
});
