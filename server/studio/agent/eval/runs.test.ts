import { FINGERPRINT_ASK, promptFingerprint } from "./runs";
import { agentPrompt } from "../plan";

describe("the prompt fingerprint", () => {
  it("is stable for the same template, twelve hex characters, and moves when the template moves", () => {
    const a = promptFingerprint();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(promptFingerprint()).toBe(a);
    // The synthetic ask renders every branch — product offered, a clip line, a pick — so a change to
    // any of them moves the fingerprint.
    const prompt = agentPrompt(FINGERPRINT_ASK);
    expect(prompt).toContain('"product"');
    expect(prompt).toContain("CLIP 6s");
    expect(prompt).toContain("her pick: yes");
  });
});
