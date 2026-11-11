// Open Mila from anywhere in the app with a launching context and (optionally) a draft in the
// composer. The overlay lives in MainTabNavigator; until now it could only be opened from the
// tab bar with the tab's own context. A record row's "Tell Mila" needs the field it came from.
//
// The draft is NOT auto-sent — the athlete sees it in the composer and taps send (or edits it).

import type { MilaContext } from "../hooks/use-mila-chat";

export interface MilaLaunch {
  context?: MilaContext;
  draft?:   string;
  /**
   * AGENT_V3: a message Mila is asked straight away — the athlete's own tap on "Start" (a capability, a goal's action).
   * Sent once, as that tap; never set by anything the athlete didn't press.
   */
  prompt?:  string;
  /** Open this saved chat of hers (a Mila suggestion's card lives there: the push and Home's row open it). */
  conversationId?: string;
}

type Listener = (launch: MilaLaunch) => void;
const listeners = new Set<Listener>();

export function openMila(launch: MilaLaunch): void {
  listeners.forEach((fn) => fn(launch));
}

export function subscribeMilaLaunch(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
