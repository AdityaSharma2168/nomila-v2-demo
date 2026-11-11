/**
 * geminiSourceRead — the targeted source read's request shapes (URL context for a page, native video input for a public YouTube
 * video) and its one-attempt, reserve-first, page-must-be-retrieved semantics. The genai client is mocked: no network.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGenerateContent = jest.fn<(params: any) => Promise<any>>();
jest.mock("../../models", () => ({ genai: () => ({ models: { generateContent: mockGenerateContent } }), GEMINI: { flash: "gemini-test-flash" } }));

import { geminiSourceRead, runGeminiSourceReadOnce, sourceReadParams, URL_RETRIEVAL_SUCCESS, YOUTUBE_MIME_TYPE, type SourceReadRaw } from "./geminiSourceRead";
import { SOURCE_READ_SYSTEM_INSTRUCTION } from "../../../services/intelligence/research/spec/sourceReadV1";

const PAGE = { url: "https://news.example.com/interview", mode: "page" as const, request: "Read https://news.example.com/interview", envelopeId: "r0" };
const VIDEO = { url: "https://www.youtube.com/watch?v=abcDEF12345", mode: "youtube" as const, request: "Read the attached video", envelopeId: "r1" };
const raw = (o: Partial<SourceReadRaw> = {}): SourceReadRaw => ({ text: '{"statements":[]}', urlMetadata: [], finishReason: "STOP", promptTokens: 1000, candidateTokens: 200, thoughtTokens: 50, ...o });

beforeEach(() => { mockGenerateContent.mockReset(); });

describe("request shapes", () => {
  it("a page is read through the URL-context tool, the URL in the text; no file part", () => {
    const p = sourceReadParams(PAGE);
    expect(p.model).toBe("gemini-test-flash");
    expect(p.contents).toEqual([{ role: "user", parts: [{ text: PAGE.request }] }]);
    expect(p.config).toMatchObject({ tools: [{ urlContext: {} }], systemInstruction: SOURCE_READ_SYSTEM_INSTRUCTION });
  });
  it("a public YouTube video is native video input: a fileData part with the watch URL, then the text; no tools", () => {
    const p = sourceReadParams(VIDEO);
    expect(p.contents).toEqual([{ role: "user", parts: [{ fileData: { fileUri: VIDEO.url, mimeType: YOUTUBE_MIME_TYPE } }, { text: VIDEO.request }] }]);
    expect(p.config).not.toHaveProperty("tools");
  });
  it("runGeminiSourceReadOnce sends exactly those parameters to the (mocked) client and reads the URL-context metadata", async () => {
    mockGenerateContent.mockResolvedValue({ text: "{}", candidates: [{ finishReason: "STOP", urlContextMetadata: { urlMetadata: [{ retrievedUrl: PAGE.url, urlRetrievalStatus: URL_RETRIEVAL_SUCCESS }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    const r = await runGeminiSourceReadOnce(PAGE);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0]).toMatchObject({ contents: [{ parts: [{ text: PAGE.request }] }], config: { tools: [{ urlContext: {} }] } });
    expect(r).toMatchObject({ text: "{}", urlMetadata: [{ retrievedUrl: PAGE.url, status: URL_RETRIEVAL_SUCCESS }], promptTokens: 10, candidateTokens: 5 });
  });
});

describe("one budgeted read", () => {
  it("reserves BEFORE the call; a refusal makes no call", async () => {
    const call = jest.fn(async () => raw());
    const r = await geminiSourceRead(PAGE, { reserve: async () => false, call });
    expect(call).not.toHaveBeenCalled();
    expect(r).toMatchObject({ refused: true, completed: false, attempts: 0 });
  });
  it("a page counts as read only when URL context reports a successful retrieval", async () => {
    const ok = await geminiSourceRead(PAGE, { reserve: async () => true, call: async () => raw({ urlMetadata: [{ retrievedUrl: PAGE.url, status: URL_RETRIEVAL_SUCCESS }] }) });
    expect(ok).toMatchObject({ completed: true, attempts: 1, refused: false, error: null });
    expect(ok.envelope).toMatchObject({ id: "r0", provider: "gemini_direct", chunks: [{ id: "r0:c0", url: PAGE.url, domain: "news.example.com" }], request: { path: "source-read", params: { mode: "page", readSpec: "source-read/1", url: PAGE.url } }, usage: { promptTokens: 1000, completionTokens: 250, calls: 1 }, errors: [] });
    const failed = await geminiSourceRead(PAGE, { reserve: async () => true, call: async () => raw({ urlMetadata: [{ retrievedUrl: PAGE.url, status: "URL_RETRIEVAL_STATUS_ERROR" }] }) });
    expect(failed).toMatchObject({ completed: false, attempts: 1, error: expect.stringMatching(/did not retrieve/) });
    const none = await geminiSourceRead(PAGE, { reserve: async () => true, call: async () => raw() });
    expect(none).toMatchObject({ completed: false, error: expect.stringMatching(/no URL-context retrieval metadata/) });
  });
  it("a video read completes on an answer; an empty answer, a thrown call or a timeout does not (one attempt, never retried)", async () => {
    expect(await geminiSourceRead(VIDEO, { reserve: async () => true, call: async () => raw() })).toMatchObject({ completed: true, attempts: 1 });
    expect(await geminiSourceRead(VIDEO, { reserve: async () => true, call: async () => raw({ text: "" }) })).toMatchObject({ completed: false, error: expect.stringMatching(/empty answer/) });
    const thrown = jest.fn(async (): Promise<SourceReadRaw> => { throw new Error("400 video unavailable"); });
    expect(await geminiSourceRead(VIDEO, { reserve: async () => true, call: thrown })).toMatchObject({ completed: false, attempts: 1, error: "400 video unavailable" });
    expect(thrown).toHaveBeenCalledTimes(1);
    const slow = await geminiSourceRead(VIDEO, { reserve: async () => true, timeoutMs: 5, call: () => new Promise((r) => setTimeout(() => r(raw()), 200)) });
    expect(slow).toMatchObject({ completed: false, attempts: 1, error: expect.stringMatching(/timed out/) });
  });
});
