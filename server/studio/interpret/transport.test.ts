/**
 * transport.test.ts — the one Gemini call, with `genai()` stood in for (the interpreter, I.3). Asserts
 * the request the product transport sends — the WHOLE wire, field by field — and how it reads the answer
 * back. No model is called.
 *
 * ⚠️ THE WIRE IS PINNED EXACTLY, because interpret/1's was refused by Vertex (400 INVALID_ARGUMENT, R1,
 * 2026-09-14) for fields no test here said it sent: a `responseJsonSchema` and a `thinkingLevel`. The
 * config is now detection's own pair plus Mila's thinking shape, and a field added to it is red here.
 */
const generateContent = jest.fn();
jest.mock("../../lib/models", () => ({
  genai: jest.fn(() => ({ models: { generateContent } })),
  GEMINI: { flash: "shared-flash-that-must-not-leak" },
}));

import { geminiTransport, interpreterRequest } from "./transport";

const REQ = {
  prompt: "the prompt",
  image: { bytes: Buffer.from("frame"), mimeType: "image/jpeg" },
};

const ENV = [
  "STUDIO_INTERPRETER_MODEL",
  "STUDIO_INTERPRETER_THINKING_BUDGET",
  "STUDIO_INTERPRETER_TIMEOUT_MS",
  "GEMINI_FLASH_MODEL",
];

beforeEach(() => {
  generateContent.mockReset();
  for (const k of ENV) delete process.env[k];
});

describe("the interpreter's one call", () => {
  it("sends exactly detection's pair and Mila's thinking shape — no schema, no thinking level", () => {
    expect(interpreterRequest(REQ).config).toEqual({
      responseMimeType: "application/json",
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it("asks its own pinned model, the frame then the prompt, and reads the answer back", async () => {
    // Another feature moving the SHARED flash model must not move this one (A8).
    process.env.GEMINI_FLASH_MODEL = "gemini-something-else";
    generateContent.mockResolvedValue({
      text: '{"decline":true}',
      usageMetadata: {
        promptTokenCount: 2400,
        candidatesTokenCount: 300,
        thoughtsTokenCount: 80,
      },
    });
    const out = await geminiTransport(REQ);
    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("gemini-3.5-flash");
    // On the wire: the pinned config, plus the client-side abort signal and nothing else.
    const { abortSignal, ...wire } = call.config;
    expect(abortSignal).toBeInstanceOf(AbortSignal);
    expect(wire).toEqual(interpreterRequest(REQ).config);
    expect(call.config.responseJsonSchema).toBeUndefined();
    // The frame first, then the prompt — detection's own shape.
    expect(call.contents[0].parts).toEqual([
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: Buffer.from("frame").toString("base64"),
        },
      },
      { text: "the prompt" },
    ]);
    // Out-tokens include thinking, which bills.
    expect(out).toEqual({
      text: '{"decline":true}',
      usage: { inputTokens: 2400, outputTokens: 380 },
      model: "gemini-3.5-flash",
    });
  });

  it("moves only with its own settings — a model, or a thinking budget", async () => {
    process.env.STUDIO_INTERPRETER_MODEL = "gemini-3.6-flash";
    process.env.STUDIO_INTERPRETER_THINKING_BUDGET = "512";
    generateContent.mockResolvedValue({ text: "{}" });
    const out = await geminiTransport(REQ);
    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("gemini-3.6-flash");
    expect(call.config.thinkingConfig).toEqual({ thinkingBudget: 512 });
    expect(out.usage).toBeNull();
  });

  it("reads a blank or non-numeric budget as the default, never as something else", () => {
    for (const v of ["", "  ", "lots"]) {
      process.env.STUDIO_INTERPRETER_THINKING_BUDGET = v;
      expect(interpreterRequest(REQ).config.thinkingConfig).toEqual({
        thinkingBudget: 0,
      });
    }
  });

  it("gives up at its timeout, and throws — the caller turns that into her ask", async () => {
    process.env.STUDIO_INTERPRETER_TIMEOUT_MS = "20";
    generateContent.mockImplementation(() => new Promise(() => {}));
    await expect(geminiTransport(REQ)).rejects.toThrow(/timed out after 20ms/);
  });
});
