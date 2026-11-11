import { useCallback, useRef, useState } from "react";
import { apiRequest } from "../../lib/query-client";
import type {
  MilaBrandVoice,
  ProfileUpdateCandidate,
} from "../../hooks/use-mila-chat";

/**
 * useProfileConfirm — the ONE persist path for a proposed durable profile update.
 *
 * Mirrors useReplyAction: on a deliberate Save tap it PATCHes the matching
 * /me/profile/* endpoint with the CURRENT (possibly edited) value. The server is
 * the authority — it re-validates + athlete-scopes, so a bad edit 400s and never
 * writes. Client single-flight (a ref, so a double-tap can't fire twice) plus a
 * terminal "saved" state so an old card in scrollback can't re-save.
 *
 * A NON-persistable candidate (achievement) has NO endpoint — save() refuses it, so
 * the model can never trigger a write and the UI never fabricates one.
 */

export type SaveStatus = "idle" | "saving" | "saved" | "error";

const GENERIC_ERROR = "Couldn't save that. Please try again.";

// The editable text seeded into the card's input, per field.
export function candidateEditText(c: ProfileUpdateCandidate): string {
  if (c.field === "secondary_goals") {
    return Array.isArray(c.value) ? c.value.join(", ") : "";
  }
  if (c.field === "brand_voice") {
    return (c.value as MilaBrandVoice)?.tone ?? "";
  }
  // goal + achievement carry a plain string.
  return typeof c.value === "string" ? c.value : "";
}

// Map (field, edited text) → the PATCH route + body. secondary_goals splits on
// commas; brand_voice edits `tone` and preserves the proposed phrases/avoid.
function buildPatch(
  c: ProfileUpdateCandidate,
  editedText: string,
): { route: string; body: Record<string, unknown> } | null {
  const text = editedText.trim();
  switch (c.field) {
    case "goal":
      return {
        route: "/api/v1/me/profile/goal",
        body: { goal_archetype: text },
      };
    case "secondary_goals": {
      const goals = text
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
      return {
        route: "/api/v1/me/profile/secondary-goals",
        body: { secondary_goals: goals },
      };
    }
    case "brand_voice": {
      const original = (c.value as MilaBrandVoice) ?? {};
      return {
        route: "/api/v1/me/profile/brand-voice",
        body: {
          brand_voice: {
            ...(text ? { tone: text } : {}),
            ...(original.phrases?.length ? { phrases: original.phrases } : {}),
            ...(original.avoid?.length ? { avoid: original.avoid } : {}),
          },
        },
      };
    }
    default:
      // achievement — no endpoint exists.
      return null;
  }
}

export function useProfileConfirm(candidate: ProfileUpdateCandidate) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Synchronous single-flight guard — a ref, not state, so two taps in one tick
  // can't both pass the check before a re-render.
  const inFlight = useRef(false);

  const save = useCallback(
    async (editedText: string): Promise<boolean> => {
      // Never write a non-persistable candidate, and never write twice.
      if (!candidate.persistable) return false;
      if (inFlight.current || status === "saved") return false;

      const patch = buildPatch(candidate, editedText);
      if (!patch) return false;

      inFlight.current = true;
      setStatus("saving");
      setError(null);
      try {
        // apiRequest throws on non-2xx (a 400 from failed server re-validation),
        // so a rejected edit lands in the error state — nothing persisted.
        await apiRequest("PATCH", patch.route, patch.body);
        setStatus("saved");
        return true;
      } catch {
        setError(GENERIC_ERROR);
        setStatus("error");
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [candidate, status],
  );

  return { status, error, save };
}
