// Ask Mila as the centre tab (Muse: the bottom menu stays under the chat while she talks to Mila).
//
//   MilaTabScreen  the SearchAsk tab's screen: the chat itself, with tab focus standing in for the old overlay's
//                  `visible` (it seeds a launch's draft, plays her header loop, clears the composer when she leaves).
//                  It mounts on first open and stays mounted like every tab, so the transcript and the conversation id
//                  survive leaving and coming back — "New chat" is the only reset.
//   ShellTabBar    the tab bar as the navigator draws it: hidden on full-screen routes (Deal Detail), the centre button
//                  opens the Mila tab seeded with the tab she came from, and on the Mila tab the bar steps aside while
//                  the keyboard is up and returns when it is put away.
//
// Both live here, apart from MainTabNavigator, so they can be tested inside a real tab navigator without mounting
// every screen of the app.

import React from "react";
import { useIsFocused } from "@react-navigation/native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { TabBar } from "../components/shell/TabBar";
import { MilaSearchOverlay, type MilaContext, type MilaNavTarget } from "../screens/MilaSearchOverlay";
import { contextForTabName, isFullScreenRoute } from "./shellTabs";
import { usePreparedReview } from "../lib/cameraRollOffer";
import { offerLine } from "../lib/cameraRollIntakeLogic";

/** The centre tab's route name. */
export const MILA_TAB = "SearchAsk";

export function MilaTabScreen({ context, draft, prompt, onPromptSent, onNavigate, conversationId, messageId, onConversationOpened }: {
  context?: MilaContext;
  draft?: string;
  /** AGENT_V3: asked once on arrival (the athlete's own "Start" tap); onPromptSent clears it. */
  prompt?: string;
  onPromptSent?: () => void;
  onNavigate?: (target: MilaNavTarget) => void;
  /** A saved chat to open on arrival (a Mila suggestion); onConversationOpened clears it. */
  conversationId?: string;
  /** A message in that chat to open on (one Mila started, from its notification). */
  messageId?: string;
  onConversationOpened?: () => void;
}) {
  const focused = useIsFocused();
  // EXPO_PUBLIC_CAMERA_ROLL_INTAKE: a review the app-open check already prepared, offered in one tap (null otherwise).
  const prepared = usePreparedReview();
  const keep = prepared?.outcome.keep ?? [];
  const videos = keep.filter((p) => p.entry?.kind === "video").length;
  const offer = keep.length && onNavigate
    ? { label: offerLine(keep.length - videos, videos), onPress: () => onNavigate({ screen: "camera_roll", prepared: true }) }
    : null;
  return (
    <MilaSearchOverlay
      offer={offer}
      presentation="tab"
      visible={focused}
      // Nothing to close: a nav-chip's own navigation moves her off the tab, and so does any tab.
      onClose={() => {}}
      onNavigate={onNavigate}
      initialContext={context}
      initialDraft={draft}
      initialPrompt={prompt}
      onInitialPromptSent={onPromptSent}
      initialConversationId={conversationId}
      initialMessageId={messageId}
      onInitialConversationOpened={onConversationOpened}
    />
  );
}

export function ShellTabBar({ state, navigation, onLaunch }: Pick<BottomTabBarProps, "state" | "navigation"> & {
  /** The centre button was pressed from another tab: the context that tab seeds (and no draft). */
  onLaunch: (context: MilaContext | undefined) => void;
}) {
  // Deal Detail is a full-screen surface: its photo hero bleeds to every edge and the content runs under where the bar
  // would sit, so the bar is hidden while it is the focused route. tabBarStyle can't do this — the bar is a custom
  // component, so it never reads that option.
  if (isFullScreenRoute(state)) return null;

  const current = state.routes[state.index]?.name;
  const onMila = current === MILA_TAB;
  return (
    <TabBar
      state={state}
      navigation={navigation}
      // Ask Mila plays her own Mila; the bar's holds her still meanwhile (one video at a time).
      milaActive={!onMila}
      hideOnKeyboard={onMila}
      onOpenSearchAsk={() => {
        // Already there: nothing to re-seed.
        if (onMila) return;
        onLaunch(contextForTabName(current));
        navigation.navigate(MILA_TAB);
      }}
    />
  );
}
