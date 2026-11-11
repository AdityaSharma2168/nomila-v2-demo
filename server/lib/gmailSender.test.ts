/**
 * gmailSender.test — the keyless Gmail sender: signJwt → token exchange → messages.send, all Google endpoints stood
 * in by a fake fetch (no network, no ADC). Covers the JWT claims (sub = From, gmail.send ONLY), the MIME message,
 * token caching, retry on 429/5xx, the unauthorized_client error, the daily cap, and token/body-free logging.
 */
const mockLogs: { level: string; args: unknown[] }[] = [];
jest.mock("../logger", () => {
  const at = (level: string) => jest.fn((...args: unknown[]) => { mockLogs.push({ level, args }); });
  return { createLogger: jest.fn(() => ({ info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") })) };
});
jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn(() => ({ getClient: async () => ({ getAccessToken: async () => ({ token: "source-token-never-logged" }) }) })),
}));

import { buildMime, createGmailSender, encodeHeaderWord, GMAIL_SEND_SCOPE, htmlToText, parseAddress, type GmailSenderDeps } from "./gmailSender";

const SA = "runtime@proj.iam.gserviceaccount.com";
const ACCESS = "ya29.delegated-access-token-never-logged";
const SIGNED = "signed.jwt.never-logged";
const BODY_SECRET = "the-email-body-never-logged";

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake fetch routed by URL; each route may be a queue of responses (last one repeats). */
function fakeGoogle(routes: { sign?: Response[]; token?: Response[]; send?: Response[] } = {}) {
  const calls: Call[] = [];
  const q = {
    sign:  routes.sign  ?? [],
    token: routes.token ?? [],
    send:  routes.send  ?? [],
  };
  const next = (k: keyof typeof q, dflt: () => Response) => (q[k].length > 1 ? q[k].shift()! : q[k][0]?.clone() ?? dflt());
  const fetchImpl = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.startsWith("https://iamcredentials.googleapis.com/")) return next("sign", () => json(200, { keyId: "k", signedJwt: SIGNED }));
    if (u === "https://oauth2.googleapis.com/token") return next("token", () => json(200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" }));
    if (u === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") return next("send", () => json(200, { id: "msg-1", threadId: "t-1" }));
    throw new Error(`unexpected URL ${u}`);
  });
  return { calls, fetchImpl };
}

function makeSender(over: Partial<GmailSenderDeps> & { fetchImpl: any }) {
  let now = Date.parse("2026-10-10T12:00:00Z");
  const sleeps: number[] = [];
  const sender = createGmailSender({
    fetch:          over.fetchImpl,
    sourceToken:    async () => "source-token-never-logged",
    serviceAccount: SA,
    dailyCap:       over.dailyCap ?? 1500,
    now:            () => now,
    sleep:          async (ms) => { sleeps.push(ms); },
  });
  return { sender, sleeps, advance: (ms: number) => { now += ms; } };
}

const MSG = {
  from:    "Nomila <hello@nomila.co>",
  to:      "athlete@example.com",
  subject: "Your booking is confirmed — café ✓",
  html:    `<p>Hi Mia</p><p>${BODY_SECRET}</p><a href="https://app.nomila.co/x">Open</a>`,
  text:    `Hi Mia\n${BODY_SECRET}`,
  replyTo: "reply+abc@nomila.co",
};

const decodeRaw = (call: Call): string => Buffer.from(JSON.parse(String(call.init.body)).raw, "base64url").toString("utf8");

beforeEach(() => { mockLogs.length = 0; });

describe("the delegated token: signJwt as the runtime account, sub = From, gmail.send only", () => {
  test("signJwt payload carries iss/sub/scope/aud, then the jwt-bearer exchange, then messages.send with the delegated token", async () => {
    const g = fakeGoogle();
    const { sender } = makeSender({ fetchImpl: g.fetchImpl });
    const r = await sender.send(MSG);
    expect(r).toEqual({ sent: true, id: "msg-1" });

    const [sign, token, send] = g.calls;
    expect(sign.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`);
    expect((sign.init.headers as any).Authorization).toBe("Bearer source-token-never-logged");
    const claims = JSON.parse(JSON.parse(String(sign.init.body)).payload);
    expect(claims).toMatchObject({ iss: SA, sub: "hello@nomila.co", scope: GMAIL_SEND_SCOPE, aud: "https://oauth2.googleapis.com/token" });
    expect(claims.scope).toBe("https://www.googleapis.com/auth/gmail.send");
    expect(claims.exp - claims.iat).toBe(3600);

    const form = new URLSearchParams(String(token.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")).toBe(SIGNED);

    expect((send.init.headers as any).Authorization).toBe(`Bearer ${ACCESS}`);
  });

  test("the token is cached (~55 min): a second send skips signJwt + exchange; after 56 min it refreshes", async () => {
    const g = fakeGoogle();
    const { sender, advance } = makeSender({ fetchImpl: g.fetchImpl });
    await sender.send(MSG);
    await sender.send(MSG);
    expect(g.calls.map((c) => new URL(c.url).hostname)).toEqual([
      "iamcredentials.googleapis.com", "oauth2.googleapis.com", "gmail.googleapis.com", "gmail.googleapis.com",
    ]);
    advance(54 * 60_000);
    await sender.send(MSG);
    expect(g.calls.filter((c) => c.url.includes("signJwt"))).toHaveLength(1);
    advance(2 * 60_000);
    await sender.send(MSG);
    expect(g.calls.filter((c) => c.url.includes("signJwt"))).toHaveLength(2);
  });

  test("a 401 from messages.send drops the cached token and retries once with a fresh one", async () => {
    const g = fakeGoogle({ send: [json(401, { error: { code: 401, status: "UNAUTHENTICATED" } }), json(200, { id: "msg-2" })] });
    const { sender } = makeSender({ fetchImpl: g.fetchImpl });
    expect(await sender.send(MSG)).toEqual({ sent: true, id: "msg-2" });
    expect(g.calls.filter((c) => c.url.includes("signJwt"))).toHaveLength(2);
  });
});

describe("delegation not set up yet", () => {
  test("unauthorized_client → a named error that says what to configure; nothing is sent", async () => {
    const g = fakeGoogle({ token: [json(401, { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method" })] });
    const { sender } = makeSender({ fetchImpl: g.fetchImpl });
    const r = await sender.send(MSG);
    expect(r.sent).toBe(false);
    expect(r.error).toMatch(/delegation_not_configured/);
    expect(r.error).toMatch(/Domain-wide delegation/);
    expect(r.error).toContain(GMAIL_SEND_SCOPE);
    expect(g.calls.some((c) => c.url.includes("gmail.googleapis.com"))).toBe(false);
    expect(sender.sentToday()).toBe(0); // a failed send does not use up the cap
  });

  test("signJwt 403 → hints at the self token-creator grant", async () => {
    const g = fakeGoogle({ sign: [json(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission 'iam.serviceAccounts.signJwt' denied" } })] });
    const { sender } = makeSender({ fetchImpl: g.fetchImpl });
    const r = await sender.send(MSG);
    expect(r.error).toMatch(/sign_jwt_failed/);
    expect(r.error).toMatch(/serviceAccountTokenCreator/);
  });
});

describe("retry + backoff on 429/5xx", () => {
  test("429 (Retry-After honoured) then 503 then 200 → sent, with backoff between attempts", async () => {
    const g = fakeGoogle({ send: [json(429, {}, { "retry-after": "2" }), json(503, {}), json(200, { id: "msg-3" })] });
    const { sender, sleeps } = makeSender({ fetchImpl: g.fetchImpl });
    expect(await sender.send(MSG)).toEqual({ sent: true, id: "msg-3" });
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(2);
  });

  test("persistent 500 gives up after 4 attempts with a clear error", async () => {
    const g = fakeGoogle({ send: [json(500, { error: { code: 500, status: "INTERNAL" } })] });
    const { sender, sleeps } = makeSender({ fetchImpl: g.fetchImpl });
    const r = await sender.send(MSG);
    expect(r).toEqual({ sent: false, error: "gmail 500" });
    expect(g.calls.filter((c) => c.url.includes("messages/send"))).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  test("a 400 is not retried", async () => {
    const g = fakeGoogle({ send: [json(400, { error: { code: 400, status: "INVALID_ARGUMENT" } })] });
    const { sender } = makeSender({ fetchImpl: g.fetchImpl });
    expect((await sender.send(MSG)).sent).toBe(false);
    expect(g.calls.filter((c) => c.url.includes("messages/send"))).toHaveLength(1);
  });
});

describe("daily cap", () => {
  test("refuses past the cap, alerts near it (once), and resets the next UTC day", async () => {
    const g = fakeGoogle();
    const { sender, advance } = makeSender({ fetchImpl: g.fetchImpl, dailyCap: 10 });
    for (let i = 0; i < 10; i++) expect((await sender.send(MSG)).sent).toBe(true);
    const near = mockLogs.filter((l) => l.level === "warn" && String(l.args[1]).includes("near the cap"));
    expect(near).toHaveLength(1);
    const r = await sender.send(MSG);
    expect(r).toEqual({ sent: false, error: "gmail: daily send cap reached" });
    expect(mockLogs.some((l) => l.level === "error" && String(l.args[1]).includes("cap reached"))).toBe(true);
    advance(24 * 3600_000);
    expect((await sender.send(MSG)).sent).toBe(true);
    expect(sender.sentToday()).toBe(1);
  });
});

describe("the MIME message", () => {
  test("UTF-8 subject, From/To/Reply-To, multipart/alternative text then html, base64 parts", async () => {
    const g = fakeGoogle();
    const { sender } = makeSender({ fetchImpl: g.fetchImpl });
    await sender.send(MSG);
    const mime = decodeRaw(g.calls[2]);
    expect(mime).toContain("From: Nomila <hello@nomila.co>\r\n");
    expect(mime).toContain("To: athlete@example.com\r\n");
    expect(mime).toContain("Reply-To: reply+abc@nomila.co\r\n");
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from(MSG.subject, "utf8").toString("base64")}?=\r\n`);
    expect(mime).toMatch(/MIME-Version: 1\.0\r\nContent-Type: multipart\/alternative; boundary="([^"]+)"/);
    const boundary = mime.match(/boundary="([^"]+)"/)![1];
    const parts = mime.split(`--${boundary}`);
    expect(parts).toHaveLength(4); // preamble, text, html, closing
    expect(parts[1]).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(parts[2]).toContain('Content-Type: text/html; charset="UTF-8"');
    const decodePart = (p: string) => Buffer.from(p.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(decodePart(parts[1])).toBe(MSG.text);
    expect(decodePart(parts[2])).toBe(MSG.html);
  });

  test("header injection: CR/LF in subject or reply-to cannot add headers; a CR/LF recipient is refused", async () => {
    const mime = buildMime({ ...MSG, subject: "Hi\r\nBcc: evil@x.com", replyTo: "a@b.co\r\nBcc: evil@x.com" }, { boundary: "b" });
    expect(mime.split("\r\n\r\n")[0]).not.toMatch(/^Bcc:/m);
    const g = fakeGoogle();
    const { sender } = makeSender({ fetchImpl: g.fetchImpl });
    expect(await sender.send({ ...MSG, to: "a@b.co\r\nBcc: evil@x.com" })).toEqual({ sent: false, error: "gmail: invalid recipient" });
    expect(g.calls).toHaveLength(0);
  });

  test("no text part supplied → derived from the html", () => {
    expect(htmlToText(`<p>Hello <b>Mia</b></p><a href="https://x.co">Open</a>`)).toBe("Hello Mia\nOpen (https://x.co)");
  });

  test("address + header helpers", () => {
    expect(parseAddress("Nomila <hello@nomila.co>")).toEqual({ name: "Nomila", address: "hello@nomila.co" });
    expect(parseAddress("hello@nomila.co")).toEqual({ address: "hello@nomila.co" });
    expect(encodeHeaderWord("plain")).toBe("plain");
    expect(encodeHeaderWord("café")).toBe(`=?UTF-8?B?${Buffer.from("café").toString("base64")}?=`);
    expect(buildMime({ ...MSG, from: "Équipe Nomila <hello@nomila.co>" }, { boundary: "b" })).toContain(`From: =?UTF-8?B?${Buffer.from("Équipe Nomila").toString("base64")}?= <hello@nomila.co>`);
  });
});

describe("logging never prints tokens, signed JWTs, bodies or full addresses", () => {
  test("across success, retry, delegation failure and cap paths", async () => {
    const runs = [
      fakeGoogle(),
      fakeGoogle({ send: [json(503, {}), json(200, { id: "m" })] }),
      fakeGoogle({ token: [json(401, { error: "unauthorized_client" })] }),
      fakeGoogle({ send: [json(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "bad" } })] }),
    ];
    for (const g of runs) await makeSender({ fetchImpl: g.fetchImpl, dailyCap: 1 }).sender.send(MSG).then(async () => {});
    const { sender } = makeSender({ fetchImpl: fakeGoogle().fetchImpl, dailyCap: 1 });
    await sender.send(MSG); await sender.send(MSG);
    const all = JSON.stringify(mockLogs);
    expect(mockLogs.length).toBeGreaterThan(0);
    for (const secret of [ACCESS, SIGNED, "source-token-never-logged", BODY_SECRET, "athlete@example.com", "Hi Mia"]) expect(all).not.toContain(secret);
  });
});
