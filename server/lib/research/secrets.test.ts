/**
 * secrets.test.ts — the research secret collector returns provider credentials by env NAME,
 * ignores short or non-credential values, and unpacks a service-account private key.
 */

import { collectResearchSecrets } from "./secrets";

describe("collectResearchSecrets", () => {
  it("collects known provider credentials and any credential-named variable; ignores short values and DATABASE_URL", () => {
    const key = "AIza" + "x".repeat(35);
    const env = { GEMINI_API_KEY: key, YOUTUBE_DATA_API_KEY: "yt-" + "k".repeat(20), SOME_SERVICE_TOKEN: "tok_" + "z".repeat(30), SHORT_API_KEY: "abc", NODE_ENV: "test", DATABASE_URL: "postgres://user:pass@host/db", PORT: "8080" } as NodeJS.ProcessEnv;
    const s = collectResearchSecrets(env);
    expect(s).toEqual(expect.arrayContaining([key, "yt-" + "k".repeat(20), "tok_" + "z".repeat(30)]));
    expect(s).not.toContain("abc");
    expect(s).not.toContain("test");
    expect(s).not.toContain("postgres://user:pass@host/db");
  });
  it("unpacks a service-account JSON's private key (whole and per line)", () => {
    const pk = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----\n";
    const s = collectResearchSecrets({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "x@y", private_key: pk, private_key_id: "abcdef1234567890" }) } as unknown as NodeJS.ProcessEnv);
    expect(s).toEqual(expect.arrayContaining([pk.trim(), "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC", "abcdef1234567890"]));
  });
});
