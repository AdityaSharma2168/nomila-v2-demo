/**
 * publicCard.flag.test.ts — PUBLIC_CARD is on in dev (8 Oct 2026), off in prod (design-public-card-v3 §15).
 * The dev and prod Cloud Run yamls both pin it to "false", and only the exact string "true" turns it on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { publicCardEnabled } from "./config";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

describe("PUBLIC_CARD", () => {
  // Dev turned on 8 Oct 2026 (owner: "turn it on"); prod stays off until the owner names it.
  it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "false"]])("%s pins it to %s, exactly once", (file, value) => {
    const rows = envOf(file).filter((e) => e.name === "PUBLIC_CARD");
    expect(rows).toEqual([{ name: "PUBLIC_CARD", value }]);
  });

  it("only the exact string \"true\" is on", () => {
    const before = process.env.PUBLIC_CARD;
    try {
      for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
        if (v === undefined) delete process.env.PUBLIC_CARD; else process.env.PUBLIC_CARD = v;
        expect(publicCardEnabled()).toBe(false);
      }
      process.env.PUBLIC_CARD = "true";
      expect(publicCardEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.PUBLIC_CARD; else process.env.PUBLIC_CARD = before;
    }
  });
});
