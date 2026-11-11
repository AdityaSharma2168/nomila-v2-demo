/**
 * planModel.test.ts — which model the planner actually calls, through the REAL transport.
 *
 * The planner's model is its own config value (studio/agent/config.ts `agentModel`, env
 * STUDIO_AGENT_MODEL), so switching it — to Pro, or back — is an env change and never a code change.
 * That promise is only worth something if the value really reaches the call. `derivePlan` takes an
 * injected transport, and an injected transport never sees the model — so this drives the product's
 * own `geminiPlanTransport` with the SDK client mocked, and reads the model off the request it made.
 * No model is called; CI never calls one.
 */
const generateContent = jest.fn(async (_req: unknown) => ({ text: "{}" }));
jest.mock("../../lib/models", () => ({
  genai: () => ({ models: { generateContent } }),
  GEMINI: {
    flash: "registry-flash",
    flashLite: "registry-flash-lite",
    pro: "registry-pro",
  },
}));

import { geminiPlanTransport } from "./plan";

const sent = () =>
  generateContent.mock.calls.at(-1)?.[0] as {
    model: string;
    config: Record<string, unknown>;
  };
const sentModel = () => sent().model;

const ORIGINAL = process.env.STUDIO_AGENT_MODEL;
beforeEach(() => {
  generateContent.mockClear();
  delete process.env.STUDIO_AGENT_MODEL;
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.STUDIO_AGENT_MODEL;
  else process.env.STUDIO_AGENT_MODEL = ORIGINAL;
});

describe("the planner's model is a config value, not a line of code", () => {
  /**
   * ⚠️ MUTATION: default back to `GEMINI.flash`. This reds.
   *
   * The planner writes the sentences b-roll is made from now, so its default is the registry's Pro
   * model (Mia approved, 21 Sep 2026) — by the registry's identifier, never a string.
   */
  it("unset, the registry's PRO model reaches the call — and the reply says which model answered", async () => {
    const reply = await geminiPlanTransport("plan this");
    expect(sentModel()).toBe("registry-pro");
    expect(reply.model).toBe("registry-pro");
  });

  /**
   * ⚠️ MUTATION: hardcode the model in the transport (`const model = GEMINI.flash`) instead of reading
   * `agentModel()`. The override then never reaches the call, and this reds.
   */
  it("set, STUDIO_AGENT_MODEL is the model the call is made with", async () => {
    process.env.STUDIO_AGENT_MODEL = "an-override-model";
    const reply = await geminiPlanTransport("plan this");
    expect(sentModel()).toBe("an-override-model");
    expect(reply.model).toBe("an-override-model");
  });
});

describe("the thinking config follows the model", () => {
  /**
   * ⚠️ MUTATION: send Flash's zero budget to every model. This reds.
   *
   * A zero thinking budget on Gemini 3.1 Pro is undocumented (Google documents levels, and calls the
   * budget legacy). What Pro is sent daily on this project is no thinking config at all — so that is
   * what the planner sends it.
   */
  it("Pro is sent no thinking config — the shape GEMINI.pro is called with every day here", async () => {
    await geminiPlanTransport("plan this");
    expect(sent().config).not.toHaveProperty("thinkingConfig");
  });

  it("Flash, by override, keeps the zero budget it was always sent", async () => {
    process.env.STUDIO_AGENT_MODEL = "registry-flash";
    await geminiPlanTransport("plan this");
    expect(sent().config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});

describe("the planner reports what its call cost in tokens", () => {
  /**
   * MUTATION: return `usage: null` from geminiPlanTransport regardless — this reds. The plan eval
   * prints a run's total tokens from this figure; a transport that drops it makes spend invisible.
   */
  it("reads prompt, candidate and thought tokens off usageMetadata — thoughts bill as output", async () => {
    generateContent.mockResolvedValueOnce({
      text: "{}",
      usageMetadata: {
        promptTokenCount: 4000,
        candidatesTokenCount: 900,
        thoughtsTokenCount: 1500,
      },
    } as never);
    const reply = await geminiPlanTransport("prompt");
    expect(reply.usage).toEqual({ inputTokens: 4000, outputTokens: 2400 });
  });

  it("says null, never zero, when the reply carries no usage at all", async () => {
    const reply = await geminiPlanTransport("prompt");
    expect(reply.usage).toBeNull();
  });

  it("samples at the one exported temperature, so the eval can record the product's own value", async () => {
    const { PLAN_TEMPERATURE } = await import("./plan");
    await geminiPlanTransport("prompt");
    expect(sent().config.temperature).toBe(PLAN_TEMPERATURE);
  });
});
