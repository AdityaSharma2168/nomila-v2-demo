import { brandIdentityKey, sameBrandName } from "../../lib/brandName";
import { domainLabel, planMerges, type BrandRow } from "./dedupeBrandsCore";

const row = (id: number, name: string, domain: string | null, extra: Partial<BrandRow> = {}): BrandRow =>
  ({ id, name, domain, is_agency: false, created_at: `2026-0${(id % 9) + 1}-01`, ...extra });

describe("brandIdentityKey", () => {
  it("drops a legal-entity name's regional tail", () => {
    expect(brandIdentityKey("adidas America Inc.")).toBe("adidas");
    expect(brandIdentityKey("Nike USA, LLC")).toBe("nike");
    expect(brandIdentityKey("adidas")).toBe("adidas");
  });
  it("keeps a region that is part of the name", () => {
    expect(brandIdentityKey("Air Canada")).toBe("aircanada");
    expect(brandIdentityKey("Hockey Canada")).toBe("hockeycanada");
    expect(brandIdentityKey("Bank of America Corp.")).toBe("bankofamerica");
    expect(brandIdentityKey("American Eagle Outfitters Inc.")).toBe("americaneagleoutfitters");
  });
  it("sameBrandName matches the legal-entity name to the brand name only", () => {
    expect(sameBrandName("adidas America Inc.", "adidas")).toBe(true);
    expect(sameBrandName("Red Bull", "Redbull")).toBe(true);
    expect(sameBrandName("Air Canada", "Air")).toBe(false);
    expect(sameBrandName("", "")).toBe(false);
  });
});

describe("domainLabel", () => {
  it("is the registrable label", () => {
    expect(domainLabel("adidas-group.com")).toBe("adidasgroup");
    expect(domainLabel("www.nike.co.uk")).toBe("nike");
    expect(domainLabel("email.jellycat.com")).toBe("jellycat");
  });
});

describe("planMerges", () => {
  it("merges a legal-entity row into the plainly named brand row", () => {
    const { merges, skipped } = planMerges([row(204, "adidas America Inc.", "adidas-group.com"), row(52, "adidas", "adidas.com")]);
    expect(skipped).toEqual([]);
    expect(merges).toHaveLength(1);
    expect(merges[0].canonical.id).toBe(52);
    expect(merges[0].merged.map((r) => r.id)).toEqual([204]);
  });
  it("keeps the same name on unrelated domains apart", () => {
    const { merges, skipped } = planMerges([row(1, "Delta Inc.", "delta.com"), row(2, "Delta", "deltafaucet.com")]);
    expect(merges).toEqual([]);
    expect(skipped[0].reason).toBe("domain_conflict");
  });
  it("never merges an agency with a brand", () => {
    const { merges, skipped } = planMerges([row(1, "Acme", "acme.com"), row(2, "Acme LLC", null, { is_agency: true })]);
    expect(merges).toEqual([]);
    expect(skipped[0].reason).toBe("agency_mismatch");
  });
  it("leaves different names alone", () => {
    expect(planMerges([row(1, "Air Canada", "aircanada.com"), row(2, "Air", "air.com"), row(3, "Nike", "nike.com")]).merges).toEqual([]);
  });
  it("picks the oldest plainly named row when several are", () => {
    const { merges } = planMerges([row(9, "Red Bull", null, { created_at: "2026-05-01" }), row(3, "Redbull", "redbull.com", { created_at: "2026-02-01" })]);
    expect(merges[0].canonical.id).toBe(3);
  });
});
