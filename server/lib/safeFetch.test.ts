/**
 * safeFetch.test.ts — the SSRF guard (PR 4, C4). DNS and fetch are stubbed: nothing here resolves a
 * name or opens a connection. Each refused class is its own case, so a mutation reds by name.
 */
jest.mock("../logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import {
  checkAndResolve,
  checkUrl,
  isBlockedAddress,
  MAX_HOPS,
  safeFetch,
  UnsafeUrlError,
  type RequestFn,
  type Resolver,
} from "./safeFetch";

const PUBLIC = "93.184.216.34";

/** A resolver from a fixed table; any other name is public. Never DNS. */
const resolverOf =
  (table: Record<string, string[]> = {}): Resolver =>
  async (host) =>
    (table[host] ?? [PUBLIC]).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

/** A fetch that answers from a script of responses, recording what it was asked. */
function fetchOf(...responses: Response[]) {
  const calls: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const impl = jest.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      const r = responses.shift();
      if (!r) throw new Error("no scripted response left");
      return r;
    },
  ) as unknown as typeof fetch;
  return { impl, calls };
}
const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });
const ok = (body = "<html></html>") => new Response(body, { status: 200 });

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "allowed";
  } catch (err) {
    return err instanceof UnsafeUrlError ? err.reason : `threw ${String(err)}`;
  }
};

describe("checkUrl — every non-public destination is refused by name", () => {
  it.each([
    ["plain http", "http://brand.example/", "scheme"],
    ["a file url", "file:///etc/passwd", "scheme"],
    ["not a url", "::::", "bad_url"],
    ["localhost", "https://localhost/", "blocked_host"],
    ["a *.internal name", "https://api.corp.internal/", "blocked_host"],
    [
      "the metadata IP",
      "https://169.254.169.254/computeMetadata/v1/",
      "private_address",
    ],
    ["loopback", "https://127.0.0.1/", "private_address"],
    ["RFC 1918 10/8", "https://10.1.2.3/", "private_address"],
    ["RFC 1918 172.16/12", "https://172.20.0.1/", "private_address"],
    ["RFC 1918 192.168/16", "https://192.168.1.1/", "private_address"],
    ["CGNAT", "https://100.64.1.1/", "private_address"],
    ["0.0.0.0", "https://0.0.0.0/", "private_address"],
    ["IPv6 loopback", "https://[::1]/", "private_address"],
    ["IPv6 ULA", "https://[fd00::1]/", "private_address"],
    ["IPv6 link-local", "https://[fe80::1]/", "private_address"],
    ["IPv4-mapped private", "https://[::ffff:10.0.0.1]/", "private_address"],
  ])("%s → %s", async (_label, url, reason) => {
    expect(await reasonOf(checkUrl(url, resolverOf()))).toBe(reason);
  });

  /**
   * ⚠️ MUTATION: drop the metadata names from BLOCKED_NAMES and the `.internal` suffix check — this
   * reds by name. The resolver here LIES (answers a public address), so only the name check stands.
   */
  it("the metadata host is refused by NAME, whatever the resolver answers", async () => {
    const lying = resolverOf({
      "metadata.google.internal": [PUBLIC],
      metadata: [PUBLIC],
    });
    for (const url of [
      "https://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      "https://metadata/computeMetadata/v1/",
      "https://METADATA.GOOGLE.INTERNAL./",
    ])
      expect(await reasonOf(checkUrl(url, lying))).toBe("blocked_host");
  });

  it("a name that resolves to a private address is private — and ONE private answer among public ones is enough", async () => {
    expect(
      await reasonOf(
        checkUrl(
          "https://rebind.example/",
          resolverOf({ "rebind.example": ["127.0.0.1"] }),
        ),
      ),
    ).toBe("private_address");
    expect(
      await reasonOf(
        checkUrl(
          "https://mixed.example/",
          resolverOf({ "mixed.example": [PUBLIC, "169.254.169.254"] }),
        ),
      ),
    ).toBe("private_address");
  });

  it("a name that does not resolve is refused, not guessed", async () => {
    const failing: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await reasonOf(checkUrl("https://nowhere.example/", failing))).toBe(
      "unresolvable",
    );
  });

  it("a public https URL passes", async () => {
    expect(
      await reasonOf(checkUrl("https://www.adidas.com/", resolverOf())),
    ).toBe("allowed");
    expect(isBlockedAddress(PUBLIC)).toBe(false);
    expect(isBlockedAddress("2606:4700::1111")).toBe(false);
  });
});

describe("safeFetch — redirects are followed by hand, and every hop is checked before it is requested", () => {
  /**
   * ⚠️ MUTATION "redirect allowed": check only the first URL (or hand fetch `redirect: "follow"`) —
   * this reds by name: the hop to the metadata server is requested.
   */
  it("a redirect to the metadata server is refused at the hop, and never requested", async () => {
    const { impl, calls } = fetchOf(
      redirectTo(
        "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
      ),
    );
    expect(
      await reasonOf(
        safeFetch(
          "https://brand.example/",
          {},
          { resolve: resolverOf(), fetchImpl: impl },
        ),
      ),
    ).toBe("scheme");
    expect(calls.map((c) => c.url)).toEqual(["https://brand.example/"]);

    const second = fetchOf(redirectTo("https://169.254.169.254/latest/"));
    expect(
      await reasonOf(
        safeFetch(
          "https://brand.example/",
          {},
          { resolve: resolverOf(), fetchImpl: second.impl },
        ),
      ),
    ).toBe("private_address");
    expect(second.calls).toHaveLength(1);
  });

  it("a redirect to a name that resolves inside is refused at the hop", async () => {
    const { impl, calls } = fetchOf(
      redirectTo("https://internal-looking.example/admin", 301),
    );
    expect(
      await reasonOf(
        safeFetch(
          "https://brand.example/",
          {},
          {
            resolve: resolverOf({ "internal-looking.example": ["10.0.0.7"] }),
            fetchImpl: impl,
          },
        ),
      ),
    ).toBe("private_address");
    expect(calls).toHaveLength(1);
  });

  it("every request is made with redirect: manual — fetch never follows on its own", async () => {
    const { impl, calls } = fetchOf(redirectTo("/home"), ok());
    const res = await safeFetch(
      "https://brand.example/",
      { headers: { "User-Agent": "test" } },
      { resolve: resolverOf(), fetchImpl: impl },
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { url: "https://brand.example/", redirect: "manual" },
      { url: "https://brand.example/home", redirect: "manual" },
    ]);
  });

  it("a public page with public redirects is fetched as before", async () => {
    const { impl } = fetchOf(
      redirectTo("https://www.brand.example/"),
      redirectTo("https://www.brand.example/en/", 308),
      ok("<html>brand</html>"),
    );
    const res = await safeFetch(
      "https://brand.example/",
      {},
      { resolve: resolverOf(), fetchImpl: impl },
    );
    expect(await res.text()).toBe("<html>brand</html>");
  });

  it(`more than ${MAX_HOPS} redirects is refused`, async () => {
    const hops = Array.from({ length: MAX_HOPS + 1 }, (_, i) =>
      redirectTo(`/r${i}`),
    );
    const { impl, calls } = fetchOf(...hops);
    expect(
      await reasonOf(
        safeFetch(
          "https://brand.example/",
          {},
          { resolve: resolverOf(), fetchImpl: impl },
        ),
      ),
    ).toBe("too_many_redirects");
    expect(calls).toHaveLength(MAX_HOPS + 1);
  });

  it("the first URL is checked too — plain http is never requested at all", async () => {
    const { impl, calls } = fetchOf(ok());
    expect(
      await reasonOf(
        safeFetch(
          "http://brand.example/",
          {},
          { resolve: resolverOf(), fetchImpl: impl },
        ),
      ),
    ).toBe("scheme");
    expect(calls).toHaveLength(0);
  });
});

// ─── Lane F1 — the connection goes to the address that was checked ──────────────────────────────

interface Answer {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: Buffer[];
}

/** A fake https.request: each call answers from a script, recording the options it was handed. Never a socket. */
function requestOf(...answers: Answer[]) {
  const calls: RequestOptions[] = [];
  const request: RequestFn = (options) => {
    calls.push(options);
    const a = answers.shift();
    if (!a) throw new Error("no scripted answer left");
    const req = new EventEmitter();
    const end = () => {
      process.nextTick(() => {
        const res = Object.assign(Readable.from(a.body ?? []), {
          statusCode: a.status,
          statusMessage: "",
          headers: a.headers ?? {},
        });
        req.emit("response", res as unknown as IncomingMessage);
      });
    };
    return Object.assign(req, { end, destroy() {} }) as unknown as ClientRequest;
  };
  return { request, calls };
}

/** Ask a captured request's `lookup` what node's connect would be told for `host`. */
const lookupOf = (options: RequestOptions, host: string, all: boolean) =>
  new Promise<string[]>((resolve, reject) => {
    if (typeof options.lookup !== "function")
      return reject(new Error("no lookup on the request — the connect would resolve on its own"));
    options.lookup(host, { all }, (err, address) => {
      if (err) return reject(err);
      resolve(Array.isArray(address) ? address.map((a) => a.address) : [address]);
    });
  });

describe("safeFetch — the connection goes to the address that was checked (Lane F1)", () => {
  /**
   * ⚠️ MUTATION "re-resolve allowed": drop the `lookup` option from the request — this reds by name:
   * the connect would resolve the name again, and the second answer is private.
   */
  it("the connection is pinned to the checked address — a name that answers public then private is never re-resolved", async () => {
    let asks = 0;
    const rebinding: Resolver = async () => [
      { address: asks++ === 0 ? PUBLIC : "127.0.0.1", family: 4 },
    ];
    const { request, calls } = requestOf({ status: 200, body: [Buffer.from("ok")] });

    const res = await safeFetch("https://brand.example/", {}, { resolve: rebinding, request });

    expect(res.status).toBe(200);
    expect(asks).toBe(1); // resolved ONCE, at the check
    expect(calls).toHaveLength(1);
    expect(calls[0].hostname).toBe("brand.example"); // TLS still verifies the NAME
    expect(await lookupOf(calls[0], "brand.example", true)).toEqual([PUBLIC]); // the connect is told the checked address…
    expect(await lookupOf(calls[0], "brand.example", false)).toEqual([PUBLIC]);
    expect(asks).toBe(1); // …and the lookup asked DNS nothing more
  });

  it("every hop is its own lookup and its own pin, and the answer carries the hop's url", async () => {
    const table: Record<string, string[]> = {
      "brand.example": [PUBLIC],
      "cdn.example": ["198.41.0.4"],
    };
    const seen: string[] = [];
    const resolve: Resolver = async (host) => {
      seen.push(host);
      return table[host].map((address) => ({ address, family: 4 }));
    };
    const { request, calls } = requestOf(
      { status: 302, headers: { location: "https://cdn.example/img.png" } },
      { status: 200, headers: { "content-type": "image/png" }, body: [Buffer.from([1, 2, 3])] },
    );

    const res = await safeFetch("https://brand.example/", {}, { resolve, request });

    expect(seen).toEqual(["brand.example", "cdn.example"]);
    expect(calls.map((c) => c.hostname)).toEqual(["brand.example", "cdn.example"]);
    expect(await lookupOf(calls[1], "cdn.example", true)).toEqual(["198.41.0.4"]);
    expect(res.url).toBe("https://cdn.example/img.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it("the wrapped answer reads as fetch's did — status, headers, url, text — and a gzip body is decoded", async () => {
    const html = "<html>brand</html>";
    const { request } = requestOf(
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip", "content-length": "999" },
        body: [gzipSync(html)],
      },
      { status: 404, headers: { "content-type": "text/plain" }, body: [Buffer.from("gone")] },
      { status: 304 },
    );
    const page = await safeFetch("https://brand.example/en/", {}, { resolve: resolverOf(), request });
    expect(page.ok).toBe(true);
    expect(page.status).toBe(200);
    expect(page.url).toBe("https://brand.example/en/");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-encoding")).toBeNull(); // decoded here — the header no longer described the bytes
    expect(await page.text()).toBe(html);

    const missing = await safeFetch("https://brand.example/x", {}, { resolve: resolverOf(), request });
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("gone");

    const unchanged = await safeFetch("https://brand.example/y", {}, { resolve: resolverOf(), request });
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toBeNull();
  });

  it("what the caller asked rides on the request — headers, the signal, GET, the path — and a body is refused", async () => {
    const { request, calls } = requestOf({ status: 200, body: [] });
    const signal = AbortSignal.timeout(10_000);
    await safeFetch(
      "https://brand.example/p?q=1",
      { headers: { "User-Agent": "test-agent", Accept: "text/html" }, signal },
      { resolve: resolverOf(), request },
    );
    expect(calls[0]).toMatchObject({
      method: "GET",
      protocol: "https:",
      port: 443,
      path: "/p?q=1",
      headers: { "User-Agent": "test-agent", Accept: "text/html" },
    });
    expect(calls[0].signal).toBe(signal);
    await expect(
      safeFetch("https://brand.example/", { method: "POST", body: "x" }, { resolve: resolverOf(), request }),
    ).rejects.toThrow(/GET/);
    expect(calls).toHaveLength(1); // the refused body never reached the request
  });

  it("an IP-literal host is its own pin, and a name's pin is every address the check saw", async () => {
    const literal = await checkAndResolve("https://93.184.216.34/", resolverOf());
    expect(literal.pin).toEqual({ addresses: [{ address: "93.184.216.34", family: 4 }] });
    const named = await checkAndResolve(
      "https://brand.example/",
      resolverOf({ "brand.example": [PUBLIC, "2606:4700::1111"] }),
    );
    expect(named.pin.addresses).toEqual([
      { address: PUBLIC, family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });
});
