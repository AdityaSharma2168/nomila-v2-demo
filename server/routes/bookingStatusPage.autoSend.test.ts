/**
 * bookingStatusPage.autoSend.test — the buyer's private page /b/:token sends the email code by itself.
 *
 * Opening the page without this tab's access key (after the payment redirect, from the email link, on another device)
 * used to show a code box and an "Email me a code" button, and nothing was sent until the buyer tapped it. Now the page
 * sends the code as it opens, and does not send a second one if the same tab reloads within a minute.
 *
 * The page's inline script runs in a node:vm context with a minimal DOM and a fake fetch (no jsdom in this repo).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html = readFileSync(path.join(process.cwd(), "server/public/booking-status.html"), "utf8");
const script = html.split(/<script[^>]*>/)[1].split("</script>")[0];

class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  textContent = "";
  disabled = false;
  value = "";
  constructor(public tag: string) {}
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  appendChild(c: FakeNode): FakeNode { this.children.push(c); return c; }
  removeChild(c: FakeNode): FakeNode { this.children = this.children.filter((x) => x !== c); return c; }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(e: string, f: () => void): void { (this.listeners[e] ??= []).push(f); }
  focus(): void { /* no-op */ }
  allText(): string { return this.textContent + this.children.map((c) => c.allText()).join(" "); }
}

function openPage(storage: Map<string, string>) {
  const calls: string[] = [];
  const view = new FakeNode("div");
  const foot = new FakeNode("footer");
  const respond = (status: number, body: unknown) => Promise.resolve({ status, json: () => Promise.resolve(body) });
  const ctx = {
    document: {
      body: new FakeNode("body"),
      createElement: (t: string) => new FakeNode(t),
      createTextNode: (t: string) => { const n = new FakeNode("#text"); n.textContent = t; return n; },
      getElementById: (id: string) => (id === "view" ? view : foot),
    },
    location: { pathname: "/b/tok123", search: "", href: "", origin: "https://example.test" },
    history: { replaceState: () => undefined },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    },
    URLSearchParams,
    fetch: (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${url}`);
      if (url.endsWith("/access/send")) return respond(200, { sent: true });
      return respond(401, { error: "code needed" });   // no access key yet
    },
    Date, Number, String, JSON, Promise, setTimeout, clearTimeout,
  };
  vm.runInNewContext(script, ctx);
  return { calls, view };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

test("opening the page without an access key emails the code by itself", async () => {
  const { calls, view } = openPage(new Map());
  await flush();
  expect(calls.filter((c) => c === "POST /api/v1/book/b/tok123/access/send")).toHaveLength(1);
  expect(view.allText()).toContain("We've emailed a 6-digit code");
  expect(view.allText()).toContain("Send a new code");
  expect(view.allText()).not.toContain("Email me a code");
});

test("a reload in the same tab within a minute does not send a second code", async () => {
  const storage = new Map<string, string>();
  openPage(storage);
  await flush();
  const again = openPage(storage);
  await flush();
  expect(again.calls.filter((c) => c.endsWith("/access/send"))).toHaveLength(0);
  expect(again.view.allText()).toContain("Send a new code");
});
