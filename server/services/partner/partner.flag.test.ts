/**
 * partner.flag.test.ts — PARTNER_INTAKE is "true" in dev (the public profile wiring PR) and "false" in prod, exactly
 * once each; the door also needs PUBLIC_CARD, and only the exact string "true" counts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { partnerInboundMailEnabled, partnerIntakeEnabled } from "./config";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

describe("PARTNER_INTAKE", () => {
  it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "false"]])("%s pins it to %s, exactly once", (file, value) => {
    expect(envOf(file).filter((e) => e.name === "PARTNER_INTAKE")).toEqual([{ name: "PARTNER_INTAKE", value }]);
  });

  it("needs PUBLIC_CARD too, and only the exact string \"true\"", () => {
    const keep = { a: process.env.PARTNER_INTAKE, b: process.env.PUBLIC_CARD };
    try {
      process.env.PUBLIC_CARD = "true";
      for (const v of ["", "false", "TRUE", "1"]) { process.env.PARTNER_INTAKE = v; expect(partnerIntakeEnabled()).toBe(false); }
      process.env.PARTNER_INTAKE = "true";
      expect(partnerIntakeEnabled()).toBe(true);
      process.env.PUBLIC_CARD = "false";
      expect(partnerIntakeEnabled()).toBe(false);
    } finally {
      for (const [k, v] of [["PARTNER_INTAKE", keep.a], ["PUBLIC_CARD", keep.b]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe("PARTNER_INBOUND_MAIL", () => {
  // On in dev since 3 Nov 2026 (partners@nomila.co exists, gmail.modify is on the delegation entry); prod stays off.
  it("is \"true\" in dev (exactly once) and absent in prod", () => {
    expect(envOf("cloud-run-dev.yaml").filter((e) => e.name === "PARTNER_INBOUND_MAIL")).toEqual([{ name: "PARTNER_INBOUND_MAIL", value: "true" }]);
    expect(envOf("cloud-run-prod.yaml").filter((e) => e.name === "PARTNER_INBOUND_MAIL")).toEqual([]);
  });

  it("needs the Partner door too, and only the exact string \"true\"", () => {
    const keys = ["PARTNER_INBOUND_MAIL", "PARTNER_INTAKE", "PUBLIC_CARD"] as const;
    const keep = keys.map((k) => process.env[k]);
    try {
      process.env.PUBLIC_CARD = "true"; process.env.PARTNER_INTAKE = "true";
      for (const v of ["", "false", "TRUE", "1"]) { process.env.PARTNER_INBOUND_MAIL = v; expect(partnerInboundMailEnabled()).toBe(false); }
      process.env.PARTNER_INBOUND_MAIL = "true";
      expect(partnerInboundMailEnabled()).toBe(true);
      process.env.PARTNER_INTAKE = "false";
      expect(partnerInboundMailEnabled()).toBe(false);
    } finally {
      keys.forEach((k, i) => { if (keep[i] === undefined) delete process.env[k]; else process.env[k] = keep[i]; });
    }
  });
});
