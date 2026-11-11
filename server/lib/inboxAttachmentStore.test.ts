/**
 * The object paths files are stored under.
 *
 * These are pure string builders, and they were untested — which is how a character class
 * lost its backslashes and went unnoticed: `[^\w.\-]` ("not a word character, dot or
 * hyphen") became `[^w.-]` ("not the letter w, a dot or a hyphen"), so it stripped every
 * letter except a lowercase w. A real contract filename came out as `_-_._`.
 *
 * It was cosmetic — the object is keyed by an opaque id and the true filename is kept in
 * raw_data — but it meant a file in the bucket could not be identified by looking at it.
 */

import { attachmentObjectPath, contractObjectPath } from "./inboxAttachmentStore";

const ATHLETE = "dc8f37f1-deff-43f8-8c02-e37a5cc20d4f";

describe("contractObjectPath", () => {
  it("keeps a real filename readable", () => {
    const p = contractObjectPath(ATHLETE, "u1", "Mia Bhuta Endorsement Agreement (2023-2028).pdf");
    expect(p).toBe(`athletes/${ATHLETE}/contracts/u1/Mia_Bhuta_Endorsement_Agreement_2023-2028_.pdf`);
  });

  // The exact regression: every letter but "w" was being stripped.
  it("does not eat the alphabet", () => {
    expect(contractObjectPath(ATHLETE, "u1", "adidas.pdf")).toContain("adidas.pdf");
    expect(contractObjectPath(ATHLETE, "u1", "gorjana agreement.pdf")).toContain("gorjana_agreement.pdf");
  });

  it("files under the athlete's own contract prefix", () => {
    expect(contractObjectPath(ATHLETE, "u1", "x.pdf")).toMatch(new RegExp(`^athletes/${ATHLETE}/contracts/u1/`));
  });

  it("strips path separators so a filename cannot escape its prefix", () => {
    const p = contractObjectPath(ATHLETE, "u1", "../../etc/passwd");
    expect(p).toBe(`athletes/${ATHLETE}/contracts/u1/.._.._etc_passwd`);
    expect(p.split("/")).toHaveLength(5);
  });

  it("falls back rather than producing a path ending in a slash", () => {

    expect(contractObjectPath(ATHLETE, "u1", "")).toContain("contract.pdf");
  });

  it("keeps the tail of a very long name, which is where the extension is", () => {
    const long = "a".repeat(200) + "-final.pdf";
    const p = contractObjectPath(ATHLETE, "u1", long);
    expect(p.endsWith("-final.pdf")).toBe(true);
  });
});

describe("attachmentObjectPath", () => {
  it("is content-addressed by hash, so one file forwarded twice stores once", () => {
    const a = attachmentObjectPath(ATHLETE, "abc123", "brief.pdf");
    const b = attachmentObjectPath(ATHLETE, "abc123", "brief.pdf");
    expect(a).toBe(b);
    expect(a).toBe(`athletes/${ATHLETE}/inbox/abc123/brief.pdf`);
  });

  it("sanitises the same way its sibling does", () => {
    expect(attachmentObjectPath(ATHLETE, "h", "Rate Card (2026).pdf")).toContain("Rate_Card_2026_.pdf");
  });

  it("keeps inbound attachments and uploaded contracts in separate trees", () => {
    expect(attachmentObjectPath(ATHLETE, "h", "x.pdf")).toContain("/inbox/");
    expect(contractObjectPath(ATHLETE, "u", "x.pdf")).toContain("/contracts/");
  });
});
