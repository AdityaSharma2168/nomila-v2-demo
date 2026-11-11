/**
 * outputGate.test.ts — the deterministic post-check on every public Mila answer (design-public-card-v3 §4). Each rule
 * has answers it must block and nearby answers it must let through, so the gate neither leaks nor smothers.
 */
import { fixtureCard } from "../../testUtils/publicCardFixtures";
import { fallbackLine, gateAnswer, type GateReason } from "./outputGate";

const { content } = fixtureCard("Tavi", "Okonkwo-Lind");
const gate = (text: string, toolResults: unknown[] = []) => gateAnswer({ text, content, toolResults });
const blocked = (text: string, toolResults: unknown[] = []) => {
  const v = gate(text, toolResults);
  return v.ok ? "passed" : v.reason;
};

describe("passes ordinary third-person answers from the card", () => {
  it.each([
    "From Tavi's Partnerships card: Tavi has worked with Northwind Outfitters.",
    "That's not on Tavi's card. You can send Tavi a request through Partner.",
    "Tavi's Video call is $177.96 all-in, for 30 minutes.",
    "Tavi has 12.4K Instagram followers.",
    'Tavi\'s own words on it: "Never leaves my bag."',
    'From Tavi\'s Highlights card: "I race the clock, not the lane next to me."',
    "I'm Mila, Nomila's assistant. Ask me anything about Tavi.",
    "This is Tavi's card, and I can answer from it.",
    "What's your budget range? Tavi reviews every request personally.",
    "Rates aren't on Tavi's card. You can send a request through Partner.",
    "You can follow Tavi at @example.tavi.",
    "You can suggest up to 3 times.",
  ])("%s", (t) => expect(blocked(t)).toBe("passed"));
});

const cases: Array<[GateReason, string[]]> = [
  ["impersonation", [
    "Hi, I'm Tavi! Thanks for stopping by.", "Tavi here — happy to chat.", "As Tavi, I can tell you it was hard.",
    "Thanks for asking!\n— Tavi", "My sponsors have been great.", "I train before sunrise every day.", "DM me on Instagram.",
  ]],
  ["promise", [
    "Tavi would love to work with you!", "Tavi will reply within a day.", "Tavi is available that week.", "Tavi'll be there.",
    "I promise Tavi reads every message.", "You're booked for Thursday.", "I'll make sure Tavi sees it.", "That's guaranteed.",
  ]],
  ["pronoun", ["She has worked with Northwind Outfitters.", "His story starts early.", "Ask her about it.", "He trains before sunrise."]],
  ["contact", ["Write to tavi@example.com.", "Call +1 (555) 123-4567.", "See https://example.org/tavi.", "Find Tavi at tavi.com.", "Tavi trains at 12 Harbor Street.", "Message @someone.else."]],
  ["claim", ["It boosts recovery after long swims.", "It's clinically proven.", "It helps with weight loss.", "It improves your performance."]],
  ["budget", ["That budget is enough for Tavi.", "Your budget is on the low side.", "A budget of that size works well.", "Tavi's minimum is lower than you think."]],
  ["rate", ["Tavi's rate is high this season.", "Tavi charges $1,500 per post.", "Expect around $2k.", "It usually costs 500 dollars.", "A session is $150.", "Tavi charges around 1k for a story."]],
  ["unsupported_number", ["Tavi's M.I.A. score is 712.", "Tavi has 98,000 followers.", "Tavi started in 2019.", "Tavi signed on the 23rd."]],
  ["empty", ["", "   "]],
];
describe.each(cases)("blocks %s", (reason, texts) => {
  it.each(texts)("%s", (t) => expect(blocked(t)).toBe(reason));
});

describe("numbers the tools returned this turn are allowed", () => {
  it("a published time Mila was given passes; a different one does not", () => {
    const tool = [{ times: [{ slotId: "s1", when: "Thu, Oct 15, 4:30 PM" }] }];
    expect(blocked("Tavi has published Thu, Oct 15, 4:30 PM.", tool)).toBe("passed");
    expect(blocked("Tavi has published Thu, Oct 16, 4:30 PM.", tool)).toBe("unsupported_number");
  });
  it("the published M.I.A. number passes only when it is on the card", () => {
    const withMia = { ...content, mia: { score: 712, band: "Rising", asOf: null } };
    expect(gateAnswer({ text: "Tavi's published M.I.A. score is 712 (Rising).", content: withMia, toolResults: [] }).ok).toBe(true);
    expect(gateAnswer({ text: "Tavi's published M.I.A. score is 713.", content: withMia, toolResults: [] }).ok).toBe(false);
  });
});

it("a blocked answer is replaced by the third-person fallback; without Partner it does not point at Partner", () => {
  expect(gate("I'm Tavi!")).toEqual({ ok: false, reason: "impersonation", text: "I can only share what's on Tavi's card, and that isn't on it. You can send Tavi a request through Partner." });
  const noPartner = { ...content, doors: { ...content.doors, partner: false } };
  expect(fallbackLine(noPartner)).toBe("I can only share what's on Tavi's card, and that isn't on it.");
});
