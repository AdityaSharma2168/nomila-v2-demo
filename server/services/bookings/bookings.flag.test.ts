/**
 * bookings.flag.test.ts — where Bookings v2 is switched on (the public profile wiring PR): BOOKINGS_ENABLED is "true" in
 * dev and "false" in prod; the pilot list exists ONLY in dev and names exactly the owner's dev test account (config data,
 * not code); and only an athlete on that list is bookable even with the flag on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { bookingsEnabledFor } from "./config";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

const DEV_TEST_ATHLETE = "dc8f37f1-deff-43f8-8c02-e37a5cc20d4f";
/** The "Paytest Athlete" dev test account, for end-to-end Stripe TEST-mode booking runs. */
const DEV_PAYTEST_ATHLETE = "dd1a8a80-d31b-423a-a572-9d146716cb0f";

describe("BOOKINGS_ENABLED and the pilot list", () => {
  it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "false"]])("%s pins BOOKINGS_ENABLED to %s, exactly once", (file, value) => {
    expect(envOf(file).filter((e) => e.name === "BOOKINGS_ENABLED")).toEqual([{ name: "BOOKINGS_ENABLED", value }]);
  });

  it("dev's pilot list is exactly the two dev test accounts; prod has no pilot list", () => {
    expect(envOf("cloud-run-dev.yaml").filter((e) => e.name === "BOOKINGS_PILOT_ATHLETE_IDS")).toEqual([{ name: "BOOKINGS_PILOT_ATHLETE_IDS", value: `${DEV_TEST_ATHLETE},${DEV_PAYTEST_ATHLETE}` }]);
    expect(envOf("cloud-run-prod.yaml").filter((e) => e.name === "BOOKINGS_PILOT_ATHLETE_IDS")).toEqual([]);
  });

  it("with the flag on, only a pilot athlete is bookable", () => {
    const keep = { e: process.env.BOOKINGS_ENABLED, p: process.env.BOOKINGS_PILOT_ATHLETE_IDS };
    try {
      process.env.BOOKINGS_ENABLED = "true";
      process.env.BOOKINGS_PILOT_ATHLETE_IDS = DEV_TEST_ATHLETE;
      expect(bookingsEnabledFor(DEV_TEST_ATHLETE)).toBe(true);
      expect(bookingsEnabledFor("00000000-0000-4000-8000-000000000001")).toBe(false);
      process.env.BOOKINGS_ENABLED = "false";
      expect(bookingsEnabledFor(DEV_TEST_ATHLETE)).toBe(false);
    } finally {
      for (const [k, v] of [["BOOKINGS_ENABLED", keep.e], ["BOOKINGS_PILOT_ATHLETE_IDS", keep.p]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
