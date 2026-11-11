/**
 * bookings/phoneVerify.ts — the phone-code seam (v2.1 decision: Firebase Phone Auth). The buyer's page runs Firebase's
 * phone step (the code is texted by Firebase, never by Nomila) and hands back a Firebase ID token; the server verifies
 * that token and reads its phone_number. Only that number is trusted; the token itself is never stored.
 *
 * One function, so tests replace the provider at this boundary and never reach Firebase.
 */
import { createLogger } from "../../logger";

const logger = createLogger("bookings/phoneVerify");

/** The E.164 phone number a Firebase ID token proves, or null when the token is invalid or carries no phone. */
export async function verifiedPhoneFromFirebase(idToken: unknown): Promise<string | null> {
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 4_096) return null;
  try {
    const { firebaseAuth } = await import("../../lib/auth");
    const decoded = await firebaseAuth.verifyIdToken(idToken, true);
    const phone = (decoded as { phone_number?: unknown }).phone_number;
    return typeof phone === "string" ? phone : null;
  } catch (err: any) {
    logger.info({ error: err?.code ?? err?.message }, "phone token rejected");
    return null;
  }
}
