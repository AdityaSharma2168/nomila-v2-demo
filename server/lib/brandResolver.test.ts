/**
 * brandResolver — "same name or same domain, otherwise a new row" (Opportunities PR 2), against
 * PGlite. A free-mail domain is never a brand's identity: never matched, never stored. Look-alike
 * names (containment, edit distance, domain-root prefixes) no longer merge. Existing bad rows are
 * left as they are; the read-only report lists them.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { resolveBrand, resolveBrandIdentity } from "./brandResolver";
import { listFreeMailBrands } from "../scripts/opps/freeMailBrands";
import { deals, inboxBrands } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const ids: Record<string, number> = {};

beforeAll(async () => {
  await initTestDb();
  // Seeded before the resolver's first call, so its brand cache sees them.
  for (const [name, domain] of [
    ["Shared Mailbox Brand", "gmail.com"],   // the bad shape: a free-mail domain stored as identity
    ["Acme Inc", null],
    ["Domainco", "domainco.com"],
    ["Longername1", "longername1.com"],
    ["Nike", "nike.com"],
  ] as const) {
    const [r] = await db.insert(inboxBrands)
      .values({ name, normalized_name: name.toLowerCase(), domain } as any)
      .returning({ id: inboxBrands.id });
    ids[name] = r.id;
  }
});
afterAll(async () => { await closeTestDb(); });

const rowOf = async (id: number) => (await db.select().from(inboxBrands).where(eq(inboxBrands.id, id)))[0];

describe("free-mail domains", () => {
  it("are never matched: a gmail pitch resolves by its own name, not to the row that stored gmail.com", async () => {
    const r = await resolveBrand({ domain: "gmail.com", brandName: "Smoothie Stand" });
    expect(r!.brand_id).not.toBe(ids["Shared Mailbox Brand"]);
    expect(r).toMatchObject({ brand_name: "Smoothie Stand", brand_domain: null, is_new: true });
  });

  it("are never stored: no name and a free-mail domain resolves to nothing", async () => {
    expect(await resolveBrand({ domain: "yahoo.com", brandName: null })).toBeNull();
    expect(await db.select().from(inboxBrands).where(eq(inboxBrands.domain, "yahoo.com"))).toHaveLength(0);
  });

  it("an existing row with the same NAME still matches when the sender uses free mail", async () => {
    const r = await resolveBrand({ domain: "outlook.com", brandName: "Domainco" });
    expect(r!.brand_id).toBe(ids["Domainco"]);
    expect((await rowOf(ids["Domainco"])).domain).toBe("domainco.com");   // its real domain is untouched
  });
});

describe("same name or same domain, otherwise a new row", () => {
  it("same domain (from a sending subdomain) matches whatever the name", async () => {
    expect((await resolveBrand({ domain: "email.domainco.com", brandName: "Domainco Team" }))!.brand_id).toBe(ids["Domainco"]);
  });

  it("same name matches across case, legal suffix, punctuation and spacing", async () => {
    expect((await resolveBrand({ domain: null, brandName: "ACME" }))!.brand_id).toBe(ids["Acme Inc"]);
    expect((await resolveBrand({ domain: null, brandName: "Ac-me, LLC" }))!.brand_id).toBe(ids["Acme Inc"]);
  });

  it("a name contained in a longer one is a NEW row (containment no longer merges)", async () => {
    const r = await resolveBrand({ domain: "longername.org", brandName: "Longername" });
    expect(r!.brand_id).not.toBe(ids["Longername1"]);
    expect(r).toMatchObject({ is_new: true, brand_domain: "longername.org" });
  });

  it("a near-miss spelling is a NEW row (edit distance no longer merges)", async () => {
    const r = await resolveBrand({ domain: null, brandName: "Nikee" });
    expect(r!.brand_id).not.toBe(ids["Nike"]);
    expect(r!.is_new).toBe(true);
  });

  it("a domain whose root prefixes a brand's name is a NEW row (domain-root prefix no longer merges)", async () => {
    const r = await resolveBrand({ domain: "nikemarketing.com", brandName: "Swoosh Media" });
    expect(r!.brand_id).not.toBe(ids["Nike"]);
  });

  it("an advertiser named by an agency joins only a same-name row", async () => {
    const same = await resolveBrandIdentity({ domain: "someagency.example", brandName: "Acme", advertiser: "Acme", agencyName: "Some Agency", viaAgency: true });
    expect(same!.brand_id).toBe(ids["Acme Inc"]);
    const lookAlike = await resolveBrandIdentity({ domain: "someagency.example", brandName: "Acmee", advertiser: "Acmee", agencyName: "Some Agency", viaAgency: true });
    expect(lookAlike!.brand_id).not.toBe(ids["Acme Inc"]);
  });
});

describe("existing bad rows are reported, not rewritten", () => {
  it("lists brand rows whose stored domain is free-mail, with their deal counts", async () => {
    const athleteId = await seedAthlete();
    await db.insert(deals).values({ athlete_id: athleteId, brand_id: ids["Shared Mailbox Brand"], brand_name: "Someone else" } as any);
    const rows = await listFreeMailBrands(db);
    expect(rows).toEqual([{ brand_id: ids["Shared Mailbox Brand"], name: "Shared Mailbox Brand", domain: "gmail.com", deals: 1, threads: 0, athletes: 1 }]);
    expect((await rowOf(ids["Shared Mailbox Brand"])).domain).toBe("gmail.com");   // untouched
  });
});

describe("advertiser domain from the mail (BRAND_IDENTITY_GATE)", () => {
  const agencyMail = (advertiser: string, advertiserDomain: string | null) => ({
    domain: "mail.collabs.io", brandName: advertiser, advertiser, agencyName: "Collabs", viaAgency: true, advertiserDomain,
  });
  afterEach(() => { delete process.env.BRAND_IDENTITY_GATE; });

  it("fills a domain-less advertiser row with the domain its mail literally showed", async () => {
    process.env.BRAND_IDENTITY_GATE = "true";
    const [r] = await db.insert(inboxBrands).values({ name: "Mudwater Co", normalized_name: "mudwater co", domain: null } as any).returning({ id: inboxBrands.id });
    const res = await resolveBrandIdentity(agencyMail("Mudwater Co", "mudwater.example"));
    expect(res).toMatchObject({ brand_id: r.id, brand_domain: "mudwater.example", via_agency: true });
    expect((await rowOf(r.id)).domain).toBe("mudwater.example");
  });

  it("a new advertiser row is created with that domain — never the agency's", async () => {
    process.env.BRAND_IDENTITY_GATE = "true";
    const res = await resolveBrandIdentity(agencyMail("Freshco Drinks", "freshco.example"));
    expect(res?.brand_domain).toBe("freshco.example");
    expect((await rowOf(res!.brand_id)).domain).toBe("freshco.example");
  });

  it("never takes a domain another row already holds (a merge question for review)", async () => {
    process.env.BRAND_IDENTITY_GATE = "true";
    const [r] = await db.insert(inboxBrands).values({ name: "Swoosh Fan Page", normalized_name: "swoosh fan page", domain: null } as any).returning({ id: inboxBrands.id });
    const res = await resolveBrandIdentity(agencyMail("Swoosh Fan Page", "nike.com"));
    expect(res).toMatchObject({ brand_id: r.id, brand_domain: null });
    expect((await rowOf(r.id)).domain).toBeNull();
  });

  it("gate off: the domain is ignored, as today", async () => {
    const [r] = await db.insert(inboxBrands).values({ name: "Gateoff Brand", normalized_name: "gateoff brand", domain: null } as any).returning({ id: inboxBrands.id });
    const res = await resolveBrandIdentity(agencyMail("Gateoff Brand", "gateoffbrand.example"));
    expect(res).toMatchObject({ brand_id: r.id, brand_domain: null });
  });
});
