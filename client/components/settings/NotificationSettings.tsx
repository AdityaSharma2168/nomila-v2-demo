/**
 * NotificationSettings — Settings › Notifications (PR D): her choices for what Nomila tells her phone, one switch each,
 * in the same row and switch as Classic layout (settingsRow). The kinds are off while all notifications are off.
 * GET / PATCH /api/v1/me/push/preferences (hooks/use-push-preferences).
 *
 *   phone off     the phone itself has notifications off: a row says so, and "Open Settings" opens the phone's settings
 *   not asked     she has not answered the phone's own dialog yet (she tapped "Not now" on Nomila's sheet): "Turn on
 *                 phone notifications" asks the phone now, which keeps the sheet's word that Settings is where she
 *                 turns them on
 *   brand names   off by default: the lock screen says "A brand replied", never who
 *   error         the choices could not be read: a line and Try again
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, Switch, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Spacing } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { acceptPushAsk, phonePermission } from "../../lib/push";
import { clockWords, usePushPreferences, useUpdatePushPreferences, type PushPreferences } from "../../hooks/use-push-preferences";
import { settingsRow as bt } from "./settingsRow";

export const NOTIFICATION_COPY = {
  enabled: { title: "Phone notifications", sub: "Nomila tells your phone when something needs you. Nothing is ever sent for you." },
  planReady: { title: "Your plan is ready", sub: "When a new plan has posts for you to look at" },
  brandReply: { title: "Brand replies", sub: "When a brand writes back on a deal" },
  waiting: { title: "Waiting on your tap", sub: "When something is ready for you to approve" },
  milaSuggestion: { title: "Mila's suggestions", sub: "When Mila suggests a change to your positioning" },
  quietHours: { title: "Quiet hours", sub: (from: string, to: string) => `From ${from} to ${to}, notifications arrive without a sound` },
  showBrandNames: { title: "Show brand names in notifications", sub: "Off: your lock screen says “A brand replied”, not who" },
  phoneOff: { title: "Notifications are off in your phone's settings", sub: "Nomila can't reach this phone until you turn them on there." },
  openSettings: "Open Settings",
  turnOn: { title: "Turn on phone notifications", sub: "Your phone will ask once. You can change it any time." },
  error: "Couldn't load your notification settings.",
  retry: "Try again",
} as const;

type Choice = keyof Omit<PushPreferences, "quietStart" | "quietEnd">;

/** The phone's own permission, read again whenever she comes back to the app (she may have changed it in Settings). */
function usePhonePermission() {
  const [state, setState] = useState<Awaited<ReturnType<typeof phonePermission>> | null>(null);
  const read = useCallback(() => { void phonePermission().then(setState); }, []);
  const ask = useCallback(async () => { await acceptPushAsk(); read(); }, [read]);
  useEffect(() => {
    read();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") read(); });
    return () => sub.remove();
  }, [read]);
  return { state, ask };
}

export function NotificationSettings() {
  const q = usePushPreferences();
  const update = useUpdatePushPreferences();
  const { state: phone, ask } = usePhonePermission();
  const p = q.data;
  if (!p) {
    if (q.isError) {
      return (
        <View style={bt.row} testID="push-preferences-error">
          <Text style={[bt.sub, { flex: 1 }]}>{NOTIFICATION_COPY.error}</Text>
          <Pressable onPress={() => { void q.refetch(); }} accessibilityRole="button" hitSlop={8} testID="push-preferences-retry">
            <Text style={bt.title}>{NOTIFICATION_COPY.retry}</Text>
          </Pressable>
        </View>
      );
    }
    return <ActivityIndicator color={Colors.light.primary} style={{ marginVertical: Spacing.xl }} />;
  }
  const row = (key: Choice, title: string, sub: string, disabled = false) => (
    <View style={[bt.row, disabled && { opacity: 0.5 }]} key={key}>
      <View style={bt.text}>
        <Text style={bt.title}>{title}</Text>
        <Text style={bt.sub}>{sub}</Text>
      </View>
      <Switch
        value={p[key] ?? true}
        disabled={disabled || update.isPending}
        onValueChange={(v) => { haptics.select(); update.mutate({ [key]: v }); }}
        trackColor={{ true: Colors.light.primary, false: Colors.light.backgroundTertiary }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={Colors.light.backgroundTertiary}
        accessibilityLabel={title}
        testID={`push-pref-${key}`}
      />
    </View>
  );
  const off = !p.enabled;
  return (
    <View testID="push-preferences">
      {phone === "denied" ? (
        <>
          <View style={bt.row} testID="push-phone-off">
            <View style={bt.iconWrap}><Feather name="bell-off" size={18} color={Colors.light.primary} /></View>
            <View style={bt.text}>
              <Text style={bt.title}>{NOTIFICATION_COPY.phoneOff.title}</Text>
              <Text style={bt.sub}>{NOTIFICATION_COPY.phoneOff.sub}</Text>
            </View>
          </View>
          <Pressable style={bt.row} onPress={() => { void Linking.openSettings(); }} accessibilityRole="button" testID="push-open-settings">
            <View style={bt.text}><Text style={bt.title}>{NOTIFICATION_COPY.openSettings}</Text></View>
            <Feather name="chevron-right" size={18} color="#9C968D" />
          </Pressable>
        </>
      ) : phone === "undetermined" ? (
        <Pressable style={bt.row} onPress={() => { haptics.select(); void ask(); }} accessibilityRole="button" testID="push-turn-on">
          <View style={bt.iconWrap}><Feather name="bell" size={18} color={Colors.light.primary} /></View>
          <View style={bt.text}>
            <Text style={bt.title}>{NOTIFICATION_COPY.turnOn.title}</Text>
            <Text style={bt.sub}>{NOTIFICATION_COPY.turnOn.sub}</Text>
          </View>
          <Feather name="chevron-right" size={18} color="#9C968D" />
        </Pressable>
      ) : null}
      {row("enabled", NOTIFICATION_COPY.enabled.title, NOTIFICATION_COPY.enabled.sub)}
      {row("planReady", NOTIFICATION_COPY.planReady.title, NOTIFICATION_COPY.planReady.sub, off)}
      {row("brandReply", NOTIFICATION_COPY.brandReply.title, NOTIFICATION_COPY.brandReply.sub, off)}
      {row("waiting", NOTIFICATION_COPY.waiting.title, NOTIFICATION_COPY.waiting.sub, off)}
      {row("milaSuggestion", NOTIFICATION_COPY.milaSuggestion.title, NOTIFICATION_COPY.milaSuggestion.sub, off)}
      {row("quietHours", NOTIFICATION_COPY.quietHours.title, NOTIFICATION_COPY.quietHours.sub(clockWords(p.quietStart), clockWords(p.quietEnd)), off)}
      {row("showBrandNames", NOTIFICATION_COPY.showBrandNames.title, NOTIFICATION_COPY.showBrandNames.sub, off)}
    </View>
  );
}
