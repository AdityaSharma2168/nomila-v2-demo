/**
 * Press vs content collaboration (8 Oct). A sender asking to make "day-in-the-life" video content WITH the athlete was
 * tagged MEDIA → "Interview": the prompt's MEDIA definition itself listed a video "day in the life" and any "creator"
 * as press. No keyword rule decides this — the model does, so the fix is the model's definitions, measured on
 * server/skills/__fixtures__/classifier-eval.dev.jsonl (docs/plans/classifier-eval-results.md). This suite pins the
 * definitions and the code's handling of the model's answer. The model is MOCKED: nothing reaches a provider.
 */
jest.mock("../db", () => ({ db: {} })); // classifyMessage is pure here: no database (a lazy PGlite boot outlived the suite in CI)
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));
jest.mock("../lib/models", () => {
  const generateContent = jest.fn();
  const client = { models: { generateContent } };
  return { genai: () => client, GEMINI: { flash: "stub-flash", flashLite: "stub-flash-lite", pro: "stub-pro" }, KIMI: { vertexModel: "stub-kimi", moonshotModel: "stub-kimi" } };
});

import { CLASSIFY_SYSTEM, classifyMessage } from "./dealDetector";
import { genai } from "../lib/models";

const generateContent = (genai() as unknown as { models: { generateContent: jest.Mock } }).models.generateContent;
const answer = (o: Record<string, unknown>) => generateContent.mockResolvedValueOnce({ text: JSON.stringify({ is_deal: true, confidence: 0.9, brand_name: "Studio", ...o }) });

describe("the classifier's definitions", () => {
  const media = CLASSIFY_SYSTEM.slice(CLASSIFY_SYSTEM.indexOf("- MEDIA"), CLASSIFY_SYSTEM.indexOf("- CONTENT COLLABORATION"));

  it("defines MEDIA as press coverage OF the athlete, without a format that is really a collaboration", () => {
    expect(media).toMatch(/COVERAGE OF the athlete/);
    expect(media).not.toMatch(/day in the life/i);
    expect(media).not.toMatch(/\bcreator\b/i);
  });

  it("defines a content collaboration (making content WITH her) as NOT MEDIA, and says where it goes", () => {
    expect(CLASSIFY_SYSTEM).toMatch(/CONTENT COLLABORATION is NOT MEDIA/);
    expect(CLASSIFY_SYSTEM).toMatch(/MAKE\s+CONTENT TOGETHER/);
    expect(CLASSIFY_SYSTEM).toMatch(/Classify it PAID/);
    expect(CLASSIFY_SYSTEM).toMatch(/"feature" \(an outlet's profile or feature about her/);
  });

  it("files billing mail (invoices, receipts, statements, payment notices) from any company, brand or not, as NOISE", () => {
    const rule = CLASSIFY_SYSTEM.slice(CLASSIFY_SYSTEM.indexOf("- Billing from any company"), CLASSIFY_SYSTEM.indexOf("- Personal / fan"));
    expect(rule).toMatch(/invoices, receipts, account or billing\s+statements, remittance or payment advice/);
    expect(rule).toMatch(/not an offer to the\s+athlete, even when it names an amount → NOISE, is_deal false/);
    // it sits inside the CORE TEST, before any category is picked
    expect(CLASSIFY_SYSTEM.indexOf("- Billing from any company")).toBeLessThan(CLASSIFY_SYSTEM.indexOf("Only after a message passes the CORE TEST"));
  });
});

describe("classifyMessage keeps the model's verdict", () => {
  it("a content collaboration the model reads as PAID carries no press chip, even if it names a media kind", async () => {
    answer({ category: "PAID", media_kind: "feature" });
    const c = await classifyMessage("Creator <c@studio.example.com>", "Collab idea", "Let's film a day together for my channel.");
    expect(c.category).toBe("PAID");
    expect(c.media_kind).toBeNull();
  });

  it("press the model reads as MEDIA keeps its kind", async () => {
    answer({ category: "MEDIA", media_kind: "feature" });
    const c = await classifyMessage("Producer <p@network.example.org>", "Profile", "We'd like to profile you for our programme.");
    expect(c.category).toBe("MEDIA");
    expect(c.media_kind).toBe("feature");
  });
});
