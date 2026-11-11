/**
 * fakeKms — an in-memory stand-in for Cloud KMS (server/lib/tokenCrypto.ts's KmsClient).
 * Tests install it with __setKmsForTests; nothing here touches the network or ADC.
 * "Wrapping" is reversible obfuscation bound to the key name, so a wrong kid fails to unwrap.
 */
import { createHash } from "node:crypto";
import type { KmsClient } from "../lib/tokenCrypto";

export const TEST_KMS_KEY = "projects/test-project/locations/us-central1/keyRings/test-ring/cryptoKeys/test-key";

const pad = (keyName: string) => createHash("sha256").update(keyName).digest();
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((x, i) => x ^ b[i % b.length]));

export interface FakeKms extends KmsClient {
  calls: { wrap: number; unwrap: number };
}

export function createFakeKms(): FakeKms {
  const calls = { wrap: 0, unwrap: 0 };
  return {
    calls,
    async wrap(keyName, dek) {
      calls.wrap++;
      return Buffer.concat([Buffer.from("fake:"), xor(dek, pad(keyName))]).toString("base64");
    },
    async unwrap(keyName, wrapped) {
      calls.unwrap++;
      const raw = Buffer.from(wrapped, "base64");
      if (raw.subarray(0, 5).toString() !== "fake:") throw new Error("fake KMS: not a ciphertext of this key");
      return xor(raw.subarray(5), pad(keyName));
    },
  };
}
