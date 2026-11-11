// Bookings v2 — where her booking screens live.
//
// App layout B: Bookings is a section of Opportunities, so its screens are pushed on the Opportunities stack (the tab
// bar stays). MainTabNavigator mounts them with ONE line, `{BOOKINGS ? bookingStackScreens(OpStack) : null}`, and the
// Opportunities section (app layout B, components/opps/BusinessSections.tsx) gets onOpen / onSeeAll into them. Nothing else changes, so
// the layout track can move the mount points freely. How to reach them: navigation/bookingsNav.ts.
import React from "react";
import { BookingsScreen } from "../screens/bookings/BookingsScreen";
import { OfferEditorScreen } from "../screens/bookings/OfferEditorScreen";
import { OfferTimesScreen } from "../screens/bookings/OfferTimesScreen";
import { BookingDetailScreen } from "../screens/bookings/BookingDetailScreen";
import { GroupSessionScreen } from "../screens/bookings/GroupSessionScreen";
import { BlockedFansScreen } from "../screens/bookings/BlockedFansScreen";

export type { BookingsStackParamList } from "./bookingsNav";

/** The six screens, for a stack navigator's children (`{bookingStackScreens(Stack)}`). */
export function bookingStackScreens(Stack: { Screen: React.ComponentType<any> }): React.ReactElement[] {
  const S = Stack.Screen;
  return [
    <S key="Bookings"      name="Bookings"      component={BookingsScreen} />,
    <S key="BookingDetail" name="BookingDetail" component={BookingDetailScreen} />,
    <S key="BookingOffer"  name="BookingOffer"  component={OfferEditorScreen} />,
    <S key="BookingTimes"  name="BookingTimes"  component={OfferTimesScreen} />,
    <S key="BookingGroup"  name="BookingGroup"  component={GroupSessionScreen} />,
    <S key="BookingBlocks" name="BookingBlocks" component={BlockedFansScreen} />,
  ];
}
