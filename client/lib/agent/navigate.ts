/**
 * agent/navigate — where an agent link lands. Cards and items carry SEMANTIC targets (a screen name the client maps, or a
 * URL); this is the one map from those to the app's routes, so neither the server nor a card ever knows a route name.
 *
 *   url               opens in the browser
 *   PitchDetail       the existing deck screen (Studio › PitchDetail), today's decks
 *   studio            the Studio library (an item id focuses it)
 *   post-kit          a post action's post kit (Studio › PostKit), direct — not the library focused on it
 *   goals             the Goals tab
 *   home · opportunities · me
 *   goal (an id) · scouting (a section, on Me) · knows   the chat's open_screen allow-list (shared OPEN_SCREENS)
 *   deal (an id) · deals-closed · booking (an id)   Mila's deal and booking cards (see chatTargetFor)
 *   camera-roll       the camera-roll review (Studio › CameraRollReview), its id the review's filter
 *                     (shared/cameraRollIntake.ts) — check_camera_roll's card, behind CAMERA_ROLL_INTAKE
 * Anything else does nothing (a future target from the server never routes somewhere broken).
 */
import { Linking } from "react-native";
import type { CardLinkTarget, StudioItem } from "./types";

type Nav = { navigate: (...args: any[]) => void };

export type AgentTarget = CardLinkTarget | NonNullable<StudioItem["open"]>;

/** The route a target maps to, or null. Pure, so it is unit-tested. */
export function routeFor(target: AgentTarget): { url: string } | { tab: string; screen?: string; params?: object } | null {
  if ("url" in target) return { url: target.url };
  const id = "id" in target ? target.id : undefined;
  const params = "params" in target ? target.params : undefined;
  switch (target.screen) {
    case "PitchDetail":
      return { tab: "Studio", screen: "PitchDetail", params };
    case "studio":
      return { tab: "Studio", screen: "StudioHome", params: { focus: id ?? (params as any)?.id } };
    case "post-kit":
      return { tab: "Studio", screen: "PostKit", params: { id: id ?? (params as any)?.id } };
    case "goals":
      return { tab: "Strategy", screen: "StrategyRoot" };
    case "home":
      return { tab: "Home", screen: "Landing" };
    case "opportunities":
      // With an id (a payment notification): that brand's opportunity; without one, the board.
      return id
        ? { tab: "Opportunities", screen: "OpportunityDetail", params: { opportunityId: id } }
        : { tab: "Opportunities", screen: "OpportunitiesList" };
    // A booking push (server/services/bookings/push.ts): her side of that booking.
    case "booking":
      return id ? { tab: "Opportunities", screen: "BookingDetail", params: { bookingId: id } } : { tab: "Opportunities", screen: "OpportunitiesList" };
    case "me":
      return { tab: "Home", screen: "Me" };
    // open_screen (shared OPEN_SCREENS): one goal, a scouting report section (on Me), What Nomila knows.
    case "goal":
      return { tab: "Strategy", screen: "StrategyRoot", params: id ? { goalId: id } : undefined };
    case "scouting":
      return { tab: "Home", screen: "Me", params: id ? { section: id } : undefined };
    case "knows":
      return { tab: "Home", screen: "Knows" };
    case "camera-roll":
      return { tab: "Studio", screen: "CameraRollReview", params: id ? { ask: id } : undefined };
    default:
      return null;
  }
}

export function openAgentTarget(nav: Nav, target: AgentTarget): boolean {
  const r = routeFor(target);
  if (!r) return false;
  if ("url" in r) { Promise.resolve(Linking.openURL(r.url)).catch(() => {}); return true; }
  nav.navigate(r.tab, r.screen ? { screen: r.screen, params: r.params } : undefined);
  return true;
}

type ChatTarget =
  | { screen: "studio" | "pitches" | "deals" | "media" | "facts" | "story" | "profile" | "home" }
  | { screen: "goals"; goalId?: string }
  | { screen: "me"; section?: string }
  | { screen: "camera_roll"; ask?: string }
  | { screen: "opportunity"; opportunityId: string }
  | { screen: "deals_closed" }
  | { screen: "booking"; bookingId: string };

/**
 * A card link inside the Mila chat, as the chat's own nav target (the overlay already routes those), or a URL. The
 * open_screen allow-list (shared OPEN_SCREENS) lands here: home, goals, goal (an id), me, scouting (a section on Me),
 * knows (What Nomila knows).
 */
export function chatTargetFor(target: CardLinkTarget): ChatTarget | { url: string } | null {
  if ("url" in target) return { url: target.url };
  switch (target.screen) {
    case "studio": return { screen: "studio" };
    case "PitchDetail":
    case "pitches": return { screen: "pitches" };
    case "opportunities":
    case "deals": return { screen: "deals" };
    case "media": return { screen: "media" };
    case "knows":
    case "facts": return { screen: "facts" };
    case "story": return { screen: "story" };
    case "profile": return { screen: "profile" };
    case "home": return { screen: "home" };
    case "goals": return { screen: "goals" };
    case "goal": return target.id ? { screen: "goals", goalId: target.id } : { screen: "goals" };
    case "me": return { screen: "me" };
    case "scouting": return target.id ? { screen: "me", section: target.id } : { screen: "me" };
    case "camera-roll": return target.id ? { screen: "camera_roll", ask: target.id } : { screen: "camera_roll" };
    // Mila's deal and booking cards (shared DEAL_SCREENS; AGENT_DEALS_TOOLS / AGENT_BOOKINGS_TOOLS): one deal's detail
    // (closed ones read-only), her past deals, one booking.
    case "deal": return target.id ? { screen: "opportunity", opportunityId: target.id } : { screen: "deals" };
    case "deals-closed": return { screen: "deals_closed" };
    case "booking": return target.id ? { screen: "booking", bookingId: target.id } : { screen: "deals" };
    default: return null;
  }
}
