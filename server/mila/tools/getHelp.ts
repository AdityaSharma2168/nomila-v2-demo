/**
 * getHelp.ts — Mila tool: how the app works + what Mila can do.
 *
 * Returns the static capabilities catalog (server/mila/capabilities.ts) — a factual
 * list of Mila's built features and every navigable screen. It reads no athlete data
 * (athlete-agnostic, no tenancy surface) and takes no args. The model answers the
 * how-do-I / what-can-you-do question from the catalog, and pairs the answer with a
 * `navigate` chip to the relevant screen where useful.
 *
 * Honesty: the catalog marks navigate-only screens (Studio/Pitches/Media/Signals)
 * with milaCanRead=false — the model must offer to take the athlete there, never
 * imply it can report on their contents (no read tool for those exists).
 */

import { z } from "zod";
import type { MilaTool } from "../types";
import { helpCatalog } from "../capabilities";

export const getHelpTool: MilaTool<z.ZodObject<Record<string, never>>> = {
  name: "get_help",
  description:
    "Answer how-do-I and what-can-you-do questions about USING the Nomila app and " +
    "what Mila can do — navigation, features, where things live. Returns a factual " +
    "capabilities catalog plus every navigable screen and how to reach it. Use this " +
    "for app-usage questions, NOT for questions about the athlete's own data (use a " +
    "read tool for those). Answer only from what it returns; never invent a feature.",
  argsSchema: z.object({}),
  async execute(_athleteId, _args) {
    // Static, bounded, athlete-agnostic — same catalog for everyone.
    return helpCatalog();
  },
};
