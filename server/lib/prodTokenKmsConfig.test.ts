/**
 * prodTokenKmsConfig.test.ts — launch board f05: prod seals OAuth tokens at rest with its own Cloud KMS key, never
 * dev's (owner, 25 Oct 2026). Reads the prod Cloud Run yaml only; nothing reaches KMS.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

type Env = { name: string; value?: string; valueFrom?: unknown };
const read = (file: string) => parse(readFileSync(join(__dirname, "..", "..", "gcp", file), "utf8")).spec.template.spec.containers[0].env as Env[];
const prod = read("cloud-run-prod.yaml");
const dev = read("cloud-run-dev.yaml");
const one = (env: Env[], name: string) => env.filter((e) => e.name === name);

test("prod seals tokens: TOKEN_KMS on, exactly once", () => {
  expect(one(prod, "TOKEN_KMS")).toEqual([{ name: "TOKEN_KMS", value: "true" }]);
});

test("prod's key is a well-formed cryptoKey of its own, not dev's", () => {
  const [key] = one(prod, "KMS_TOKEN_KEY");
  expect(one(prod, "KMS_TOKEN_KEY")).toHaveLength(1);
  expect(key.value).toMatch(/^projects\/gamechanger-pocket-agent\/locations\/us-central1\/keyRings\/nomila-tokens\/cryptoKeys\/oauth-tokens-prod$/);
  expect(key.value).not.toBe(one(dev, "KMS_TOKEN_KEY")[0]?.value);
});
