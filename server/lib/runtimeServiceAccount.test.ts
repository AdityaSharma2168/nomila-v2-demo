/**
 * runtimeServiceAccount.test.ts — each API environment runs as its own least-privilege service account.
 *
 *   dev   nomila-api-dev@ (owner script tfprod/10_api_service_accounts.sh, 26 Oct 2026); the Gmail sender signs as the same
 *         account (the code default is the old shared gamechanger-runtime@, so the yaml must say it)
 *   prod  still the shared gamechanger-runtime@ until its own, later switch to nomila-api-prod@ (then this pin moves)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const GCP = join(__dirname, "..", "..", "gcp");
const specOf = (file: string) => parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec as {
  serviceAccountName: string;
  containers: Array<{ env: Array<{ name: string; value?: string }> }>;
};
const DEV_SA = "nomila-api-dev@gamechanger-pocket-agent.iam.gserviceaccount.com";

describe("API runtime service accounts", () => {
  it("dev runs as nomila-api-dev@ and signs Gmail delegation as the same account", () => {
    const dev = specOf("cloud-run-dev.yaml");
    expect(dev.serviceAccountName).toBe(DEV_SA);
    expect(dev.containers[0].env.filter((e) => e.name === "GMAIL_SENDER_SERVICE_ACCOUNT")).toEqual([{ name: "GMAIL_SENDER_SERVICE_ACCOUNT", value: DEV_SA }]);
  });

  it("prod is unchanged until its own switch", () => {
    const prod = specOf("cloud-run-prod.yaml");
    expect(prod.serviceAccountName).toBe("gamechanger-runtime@gamechanger-pocket-agent.iam.gserviceaccount.com");
    expect(prod.containers[0].env.map((e) => e.name)).not.toContain("GMAIL_SENDER_SERVICE_ACCOUNT");
  });
});
