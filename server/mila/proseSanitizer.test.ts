/**
 * proseSanitizer.test.ts — the deterministic bracket-leak strip.
 *
 * Two tiers: bracketed UUIDs + tool names are stripped live; numbered footnotes
 * are held and stripped at finalize (the old loop never grounds). Covers
 * the pure strippers and the streaming stripper (id/tool live, footnotes held for
 * finalize, split-across-push handled).
 */

import {
  stripLeakBrackets,
  StreamingLeakStripper,
} from "./proseSanitizer";

describe("StreamingLeakStripper — widget directive", () => {
  it("captures a deal_list directive and strips it from the visible text", () => {
    const s = new StreamingLeakStripper();
    let out = s.push(
      "Your top 3: Prime, Celsius, Gymshark.\n\n<<widget:deal_list:aaa,bbb,ccc>>",
    );
    out += s.finalize();
    expect(out).toBe("Your top 3: Prime, Celsius, Gymshark.");
    expect(s.directive).toEqual({
      widget: "deal_list",
      ids: ["aaa", "bbb", "ccc"],
    });
  });

  it("captures a deal_card directive", () => {
    const s = new StreamingLeakStripper();
    let out = s.push("Prioritize the Prime deal. <<widget:deal_card:xyz>>");
    out += s.finalize();
    expect(out).toBe("Prioritize the Prime deal.");
    expect(s.directive).toEqual({ widget: "deal_card", ids: ["xyz"] });
  });

  it("captures a score directive (no ids)", () => {
    const s = new StreamingLeakStripper();
    let out = s.push("You're at 800, Elite tier. <<widget:score>>");
    out += s.finalize();
    expect(out).toBe("You're at 800, Elite tier.");
    expect(s.directive).toEqual({ widget: "score", ids: [] });
  });

  it("captures a directive split across chunks (opener + body), no leak", () => {
    const s = new StreamingLeakStripper();
    let out = s.push("Here you go. <"); // trailing lone "<" + its space held
    out += s.push("<widget:deal_card:id1>>");
    out += s.finalize();
    expect(out).toBe("Here you go.");
    expect(s.directive).toEqual({ widget: "deal_card", ids: ["id1"] });
  });

  it("strips the directive even after a footnote (footnote stripped when not grounded)", () => {
    const s = new StreamingLeakStripper();
    let out = s.push("Solid fit [1]. <<widget:score>>");
    out += s.finalize();
    expect(out).toBe("Solid fit.");
    expect(s.directive).toEqual({ widget: "score", ids: [] });
  });

  it("leaves a lone '<' in prose alone and captures no directive", () => {
    const s = new StreamingLeakStripper();
    let out = s.push("A 5 < 10 comparison, nothing to declare.");
    out += s.finalize();
    expect(out).toBe("A 5 < 10 comparison, nothing to declare.");
    expect(s.directive).toBeNull();
  });

  it("drops a truncated/unclosed directive without leaking it or capturing", () => {
    const s = new StreamingLeakStripper();
    let out = s.push("Answer. <<widget:deal_list:aaa"); // never closed
    out += s.finalize();
    expect(out).toBe("Answer.");
    expect(s.directive).toBeNull();
  });
});

describe("stripLeakBrackets (all three shapes)", () => {
  it("strips a bracketed deal UUID", () => {
    expect(
      stripLeakBrackets(
        "Your best deal is [402bb00c-8fef-44bd-9f1e-1234567890ab].",
      ),
    ).toBe("Your best deal is.");
  });

  it("strips a bracketed tool name, including comma-lists", () => {
    expect(
      stripLeakBrackets(
        "Pulled that from [get_score, 402bb00c-8fef-44bd-9f1e-1234567890ab].",
      ),
    ).toBe("Pulled that from.");
    expect(stripLeakBrackets("From [list_deals].")).toBe("From.");
  });

  it("strips numbered footnotes ([n]) and the space before them", () => {
    expect(
      stripLeakBrackets("Prime Hydration [4], Celsius [5], Gymshark [6]."),
    ).toBe("Prime Hydration, Celsius, Gymshark.");
  });

  it("leaves other brackets and 3-digit brackets untouched", () => {
    expect(stripLeakBrackets("See the note [important] and [123].")).toBe(
      "See the note [important] and [123].",
    );
  });
});

describe("StreamingLeakStripper", () => {
  it("strips id/tool inline and a held footnote at finalize", () => {
    const s = new StreamingLeakStripper();
    let out = s.push(
      "Rates ~$500 [1], id [402bb00c-8fef-44bd-9f1e-1234567890ab].",
    );
    out += s.finalize();
    expect(out).toBe("Rates ~$500, id.");
  });

  it("strips a trailing footnote", () => {
    const s = new StreamingLeakStripper();
    let out = s.push("You're a strong fit for Gymshark [1].");
    out += s.finalize(); // a footnote is always a leak here, stripped
    expect(out).toBe("You're a strong fit for Gymshark.");
  });

  it("strips an id/tool bracket split across two pushes (live, no finalize needed)", () => {
    const s = new StreamingLeakStripper();
    let out = s.push("Your deal [402bb00c-8fef-");
    out += s.push("44bd-9f1e-1234567890ab] is strong.");
    out += s.finalize();
    expect(out).not.toMatch(/\[/);
    expect(out).toContain("Your deal");
    expect(out).toContain("is strong");
  });

  it("streams bracket-free text through immediately (no holding)", () => {
    const s = new StreamingLeakStripper();
    expect(s.push("Hey — ")).toBe("Hey — ");
    expect(s.push("you're all set.")).toBe("you're all set.");
    expect(s.finalize()).toBe("");
  });
});
