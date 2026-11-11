/**
 * milaWidget.test.ts — static guarantees for the Mila web widget (server/public/p/mila.js, PR 4a). The widget's
 * behaviour was verified in Chrome over the fixtures; these checks pin the rules that must never regress.
 */
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.join(__dirname, "../../public/p/mila.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../../public/p/mila.css"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // without comments

describe("mila.js", () => {
  it("never parses data as HTML and never evaluates strings", () => {
    for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"style\""]) {
      expect({ bad, hit: code.includes(bad) }).toEqual({ bad, hit: false });
    }
  });

  it("makes no network call: no model, no fetch, no beacon (the model and counters are later PRs)", () => {
    for (const net of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource"]) expect({ net, hit: code.includes(net) }).toEqual({ net, hit: false });
  });

  it("leaves a clean transport interface for public Mila mode, and disables typing until one is set", () => {
    expect(code).toContain("setTransport:");
    expect(code).toContain("transport.send(req)");
    expect(code).toContain("input.disabled = true");
    expect(code).toContain("Typed questions open soon");
  });

  it("the avatar respects reduced motion and pauses when hidden or covered", () => {
    expect(code).toContain("prefers-reduced-motion: reduce");
    expect(code).toContain("visibilitychange");
    expect(code).toMatch(/function canPlay\(\) \{ return !reduce\.matches && document\.visibilityState === "visible"; \}/);
    expect(code).not.toContain("autoplay");
  });

  it("not-yet doors are disabled with a visible reason; Buy goes through /go/:code as a sponsored link", () => {
    expect(code).toContain("ml-chip ml-chip--soon\", disabled: true");
    expect(code).toContain("Requests to \" + first + \" open soon. Nothing can be sent yet.");
    expect(code).toContain("Booking requests open soon.");
    // With booking on (bookPath), the Book panel takes the fan to the Book door page instead of the placeholder.
    expect(code).toMatch(/if \(bookPath\) \{[\s\S]*?href: bookPath[\s\S]*?return;[\s\S]*?\}\s*add\(notYet\("Booking requests open soon/);
    expect(code).toContain("rel: \"noopener noreferrer sponsored\"");
    expect(code).toContain("\"Paid link\"");
  });

  it("the sheet is an accessible modal: dialog, live log, Escape, focus trap, focus returns", () => {
    expect(code).toContain("role: \"dialog\", \"aria-modal\": \"true\"");
    expect(code).toContain("role: \"log\", \"aria-live\": \"polite\"");
    expect(code).toContain("e.key === \"Escape\"");
    expect(code).toContain("opener.focus()");
  });

  it("visitors never see the word 'brief'; nothing athlete-specific", () => {
    expect(src.toLowerCase()).not.toContain("brief");
    expect(css.toLowerCase()).not.toContain("brief");
    for (const w of ["Avery", "Rowan", "Sam", "sprint", "rowing", "swim"]) expect(new RegExp(`\b${w}\b`, "i").test(src)).toBe(false);
  });

  it("every sheet tap target is at least 44px", () => {
    for (const sel of [".ml-back", ".ml-chip", ".ml-btn", ".ml-link", ".ml-input", ".ml-send"]) {
      const start = css.indexOf(sel + " {");
      const rule = start >= 0 ? [css.slice(start, css.indexOf("}", start))] : null;
      expect({ sel, ok: !!rule && /min-height: (4[4-9]|[5-9]\d)px/.test(rule[0]) }).toEqual({ sel, ok: true });
    }
  });
});

describe("public Mila mode in the widget (PR 5)", () => {
  const ask = fs.readFileSync(path.join(__dirname, "../../public/p/ask.js"), "utf8");
  const askCode = ask.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("ask.js talks only to this site's endpoint: JSON, the X-Nomila-Ask header, no credentials, nothing stored", () => {
    expect(askCode).toContain('credentials: "omit"');
    expect(askCode).toContain('"X-Nomila-Ask": "1"');
    expect(askCode).toContain('"Content-Type": "application/json"');
    expect(askCode).toContain('ask.endpoint.charAt(0) !== "/" || ask.endpoint.charAt(1) === "/"');
    for (const bad of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "innerHTML", "eval(", "new Function", "sendBeacon", "XMLHttpRequest"]) {
      expect({ bad, hit: askCode.includes(bad) }).toEqual({ bad, hit: false });
    }
    expect(askCode.match(/fetch\(/g)).toHaveLength(1);
  });

  it("a next-step link from a tap must be a same-site path", () => {
    expect(askCode).toContain('next.charAt(0) !== "/" || next.charAt(1) === "/"');
  });

  it("reply cards come from her published data by id, and a tap button exists only when that tap is wired", () => {
    expect(code).toContain("function canTap(kind) { return !!(transport && transport.act && transport.taps && transport.taps[kind]); }");
    expect(code).toContain('if (!canTap("booking")) return null;');
    expect(code).toContain('if (!canTap("partner")) return null;');
    expect(code).toContain("(w.ids || []).map(pick).filter(Boolean)");
    expect(code).toContain("b.disabled = true;");
    // the Partner sheet's request-kind chips route into the intake only when that tap is wired; else they stay "Soon"
    expect(code).toContain('list.appendChild(tapButton(k.label, "partner", { kind: k.id }));');
    expect(code).toContain('} else if (canTap("partner")) {');
  });
});
