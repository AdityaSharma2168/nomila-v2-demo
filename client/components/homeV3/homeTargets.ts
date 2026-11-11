// Where a Home v3 tap lands (lib/homeV3Logic HomeTarget → the app's existing screens). Nothing here acts on an item:
// each target only opens the screen where it is handled — the post kit, the opportunity's one detail, a booking, Her
// money, Settings, the phone's notification ask, or Mila's chat (handed back to the caller, which opens it as a sheet).

import { OPPS_BOARD } from "../../lib/flags";
import { leaveMeTo, openSettings } from "../../navigation/meNav";
import type { HomeTarget } from "../../lib/homeV3Logic";

type Nav = { navigate: (...args: any[]) => void; getParent?: (...args: any[]) => any; getState?: () => any };

export function openHomeTarget(navigation: Nav, t: HomeTarget, h: {
  chat: (o: { draft?: string; conversationId?: string }) => void;
  push: () => void;
  /** Me's own stack carries Settings: open it there instead of switching to Home's. */
  settings?: () => void;
}): void {
  switch (t.screen) {
    case "post_kit": leaveMeTo(navigation, "Studio", "PostKit", { id: t.id }); return;
    case "opportunity":
      if (OPPS_BOARD) { leaveMeTo(navigation, "Opportunities", "OpportunityDetail", { opportunityId: t.opportunityId }); return; }
      if (t.dealId) { leaveMeTo(navigation, "Opportunities", "DealDetail", { dealId: t.dealId }); return; }
      leaveMeTo(navigation, "Opportunities");
      return;
    case "booking": leaveMeTo(navigation, "Opportunities", "BookingDetail", { bookingId: t.bookingId }); return;
    case "financials": leaveMeTo(navigation, "Opportunities", "Financials"); return;
    case "settings": if (h.settings) h.settings(); else openSettings(navigation); return;
    case "push": h.push(); return;
    case "mila": h.chat({ draft: t.draft, conversationId: t.conversationId }); return;
  }
}
