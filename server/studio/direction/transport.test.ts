/**
 * transport.test — the very object a direction tool sends, pinned: the document rides first as a data
 * part, the instruction last; temperature is 0 unless the tool says so, and propose_campaign's 0.6 is
 * the concept step's, on purpose; thinking follows the model (Flash gets a budget, Pro gets none).
 * ⚠️ MUTATION: default the temperature to 0.6, or ignore `req.temperature` — "temperature is 0 unless a
 * tool asks, and a tool that asks gets exactly what it asked" reds by name.
 */
import { PROPOSE_TEMPERATURE } from "../config";
import { directionRequest } from "./transport";

const doc = { bytes: Buffer.from("%PDF-1.4 x"), mimeType: "application/pdf" };

describe("directionRequest", () => {
  it("temperature is 0 unless a tool asks, and a tool that asks gets exactly what it asked", () => {
    const reading = directionRequest({
      model: "gemini-3.5-flash",
      instruction: "read",
      document: doc,
    });
    expect(reading.config.temperature).toBe(0);
    const proposing = directionRequest({
      model: "gemini-3.1-pro-preview",
      instruction: "propose",
      document: null,
      temperature: PROPOSE_TEMPERATURE,
    });
    expect(proposing.config.temperature).toBe(0.6);
    expect(PROPOSE_TEMPERATURE).toBe(0.6); // the concept step's (studio/agent/plan.ts PLAN_TEMPERATURE), deliberate
  });

  it("the document rides first as a data part, the instruction last; a words-only tool sends the text alone", () => {
    const withDoc = directionRequest({
      model: "gemini-3.5-flash",
      instruction: "read",
      document: doc,
    });
    expect(withDoc.contents[0].parts).toEqual([
      {
        inlineData: {
          mimeType: "application/pdf",
          data: doc.bytes.toString("base64"),
        },
      },
      { text: "read" },
    ]);
    const wordsOnly = directionRequest({
      model: "gemini-3.1-pro-preview",
      instruction: "propose",
      document: null,
    });
    expect(wordsOnly.contents[0].parts).toEqual([{ text: "propose" }]);
    expect(wordsOnly.config.responseMimeType).toBe("application/json");
  });

  it("thinking follows the model: a budget for Flash, none at all for Pro", () => {
    const flash = directionRequest({
      model: "gemini-3.5-flash",
      instruction: "x",
      document: null,
    });
    expect(flash.config).toMatchObject({
      thinkingConfig: { thinkingBudget: 0 },
    });
    const pro = directionRequest({
      model: "gemini-3.1-pro-preview",
      instruction: "x",
      document: null,
    });
    expect("thinkingConfig" in pro.config).toBe(false);
  });
});
