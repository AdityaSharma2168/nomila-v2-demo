// BookingsSetupDoor — the Me door into Bookings before her first offer ("Sell your time").
//
// The Bookings SECTION in Opportunities is app layout B's (components/opps/BusinessSections.tsx, from the read-only GET
// /me/bookings/summary); with EXPO_PUBLIC_BOOKINGS on, OpportunitiesScreen passes it onOpen / onSeeAll so a row opens her
// booking detail and "See all" opens Bookings (navigation/bookingsNav.ts). This door covers the moment before that
// section exists: bookings are on for her (pilot) but nothing is published yet. It renders nothing otherwise — not even
// a query while the build flag is off.
import React from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { IconTile } from "../ui";
import { BOOKINGS } from "../../lib/flags";
import { useBookingsSummary } from "../../hooks/use-bookings";
import { BOOKINGS_COPY } from "../../lib/bookingsLogic";
import { fromMe } from "../../navigation/bookingsNav";
import { Bold, BoldType } from "../../constants/theme";

export function BookingsSetupDoor({ enabled = BOOKINGS, style }: { enabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return enabled ? <SetupDoor style={style} /> : null;
}

function SetupDoor({ style }: { style?: StyleProp<ViewStyle> }) {
  const navigation = useNavigation<any>();
  const summary = useBookingsSummary(true);
  const s = summary.data;
  if (!s || s.showSection || s.pausedByNomila) return null;
  return (
    <Pressable style={({ pressed }) => [styles.door, style, pressed && styles.pressed]} onPress={() => fromMe(navigation, "Bookings", { tab: "offers" })}
      accessibilityRole="button" accessibilityLabel={`${BOOKINGS_COPY.sellTitle}. ${BOOKINGS_COPY.doorDetail}`} testID="bookings-setup-door">
      <IconTile icon="calendar" bold="black" />
      <View style={styles.flex}>
        <Text style={styles.title}>{BOOKINGS_COPY.sellTitle}</Text>
        <Text style={styles.meta}>Offer a video call, a clinic or an appearance</Text>
      </View>
      <Feather name="chevron-right" size={18} color={Bold.quiet} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  door:    { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  pressed: { transform: [{ scale: Bold.pressScale }] },
  flex:    { flex: 1 },
  title:   { ...BoldType.rowTitle, color: Bold.ink },
  meta:    { ...BoldType.rowMeta, color: Bold.mute },
});
