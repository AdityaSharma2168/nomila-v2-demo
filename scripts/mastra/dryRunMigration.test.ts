/**
 * dryRunMigration.test.ts — the dry-run script never prints a connection string's credentials or the password, on any
 * error path (a fake password; no database is touched).
 */
import { redact } from "./dryRunMigration";

const PW = "s3cr+t/pa:ss";

describe("dryRunMigration redact", () => {
  it("removes the credentials of any connection string in an error", () => {
    const msg = `connect failed for postgresql://postgres:${encodeURIComponent(PW)}@127.0.0.1:5440/nomila_v2?sslmode=disable`;
    const out = redact(msg, PW);
    expect(out).toBe("connect failed for postgresql://***@127.0.0.1:5440/nomila_v2?sslmode=disable");
    expect(out).not.toContain(encodeURIComponent(PW));
  });

  it("removes the password itself wherever it appears, raw or URL-encoded", () => {
    expect(redact(`password "${PW}" rejected`, PW)).toBe(`password "***" rejected`);
    expect(redact(`bad ${encodeURIComponent(PW)}`, PW)).toBe("bad ***");
  });

  it("leaves an error without secrets as it was", () => {
    expect(redact("relation \"x\" does not exist", PW)).toBe("relation \"x\" does not exist");
  });
});
