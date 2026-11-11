/**
 * notify/templates/waitlist.ts — emails a waitlisted athlete gets, on the shared helper (render.ts / send.ts).
 *
 * Template copy, written here (not model-written, so not in the Prompt Register). Content-light: the email says the
 * score is ready and links back to her waitlist page; the score itself is shown only there, signed in. {{first}} is
 * her own first name, never hard-coded.
 */
import type { EmailTemplate } from "./render";

export const WAITLIST_TEMPLATES = {
  /** Her waitlist research finished and her M.I.A. score landed (signup_research's score_email step). Vars: first, link. */
  scoreReady: {
    name: "waitlist.score_ready",
    subject: "Your M.I.A. score is ready",
    paragraphs: [
      "Hi {{first}}, Mila has finished researching you, and your M.I.A. score is ready.",
      "See your score, what drives it, and one way to raise it on your waitlist page. Connecting your accounts moves you up the list.",
    ],
    button: { label: "See your score", urlVar: "link" },
    footer: "You're getting this because you joined the Nomila waitlist.",
  } satisfies EmailTemplate,
  /**
   * The same moment, when she was already shown a quick score (signup_research v3/v4 with a ready quick_score step;
   * dev only): her full score has replaced it. Vars: first, link.
   */
  fullScoreReady: {
    name: "waitlist.full_score_ready",
    subject: "Your full M.I.A. score is ready",
    paragraphs: [
      "Hi {{first}}, Mila has finished researching you, and your full M.I.A. score is ready. It replaces the preliminary score you saw when you joined.",
      "See your score, what drives it, and one way to raise it on your waitlist page. Connecting your accounts moves you up the list.",
    ],
    button: { label: "See your full score", urlVar: "link" },
    footer: "You're getting this because you joined the Nomila waitlist.",
  } satisfies EmailTemplate,
};

import { emailProviderConfigured } from "../../../lib/emailProvider";

const PROD_API_BASE_URL = "https://api.nomila.co";
/**
 * Production is the prod API host (Cloud Run dev also runs NODE_ENV=production, so NODE_ENV cannot tell them apart;
 * routes/devTestEmail.ts reads the same marker).
 */
const isProductionApi = () => process.env.API_BASE_URL?.trim().replace(/\/+$/, "") === PROD_API_BASE_URL;

/**
 * Where her waitlist page lives: LANDING_URL when set; in production only, nomila.co by default. Anywhere else with no
 * LANDING_URL: null, and the email is not sent, so dev mail never points at the production landing.
 */
export function waitlistPageUrl(): string | null {
  const set = process.env.LANDING_URL?.trim();
  if (set) return set.replace(/\/+$/, "") + "/";
  return isProductionApi() ? "https://nomila.co/" : null;
}

/** Whether the score-ready email can go out from this deployment at all: delivery on and a page to link to. */
export const scoreEmailEnabled = (): boolean => emailProviderConfigured() && waitlistPageUrl() !== null;
