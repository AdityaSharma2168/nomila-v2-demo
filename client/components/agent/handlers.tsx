/**
 * AgentCardHandlers — what a card's taps do OUTSIDE the card: open a link (a screen or a web page), start a workflow in
 * Mila, connect a service. The host (the Mila chat, the onboarding conversation, the gallery) provides them, so a card
 * never knows a route name. A card whose handler is absent does not draw that control: no dead taps.
 *
 * Approve / decline and fact / goal answers go through the AgentApi (lib/agent/hooks), not through here.
 */
import React, { createContext, useContext } from "react";
import type { CapabilityEntry, CardLink, CardLinkTarget, OnboardingAction } from "../../lib/agent/types";

export interface AgentCardHandlers {
  /** Open a card link: an app screen by semantic name ({screen, id}) or a web URL. */
  openLink?: (target: CardLinkTarget, link?: CardLink) => void;
  /** Start a workflow in Mila with this first message. */
  startWorkflow?: (prompt: string) => void;
  /**
   * Connect a service. Absent → the card uses the existing OAuth door (POST /me/connect/:platform). Resolves once the
   * connect flow has returned (the card then shows it as connected or asks again).
   */
  connect?: (connectorId: string) => Promise<boolean>;
  /**
   * Record what the athlete did on a card as actions (#890's turn route) — a fact reviewed, a goal answered, a connect
   * started or declined, consent, the age band, a capability tapped. Present inside the onboarding conversation; a card
   * whose answers have nowhere to go draws them read-only (no dead taps).
   */
  act?: (actions: OnboardingAction[], opts?: { reply?: boolean }) => Promise<void>;
  /** A capability was chosen: the host opens its screen or starts it in Mila. */
  startCapability?: (capability: CapabilityEntry) => void;
  /** Send a short reply as the athlete's message (a quick answer to Mila's question). */
  reply?: (text: string) => void;
  /** Put words in the composer for the athlete to finish ("Tell Mila"). Nothing is sent. */
  prefill?: (text: string) => void;
}

const Ctx = createContext<AgentCardHandlers>({});

export function AgentCardHandlersProvider({ value, children }: { value: AgentCardHandlers; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgentCardHandlers(): AgentCardHandlers {
  return useContext(Ctx);
}
