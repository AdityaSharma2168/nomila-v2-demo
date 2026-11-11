// BookingSessionScreen — Bookings v2, A6 "Video call": her side of a booked call, full screen (look B; the full-bleed
// black here IS the call surface, the screen's one black block). Opened from the booking detail (openBookingSession).
//
//   before     the booking, "Not recorded", Join (grey until 10 min before), her backup link one tap away
//   permission camera / mic asked (Android up front; iOS on first use); refused → "Allow camera in Settings" + Open
//              Settings + Try again + the backup link
//   call       the other person full-bleed, her own tile in the corner; mute · camera · flip · leave; "Waiting for
//              Jordan P." until they join; "Reconnecting…"; "Jordan P. left the call. They can rejoin until 5:00 pm.";
//              at +15 with nobody there, the "Buyer didn't show" hint; "5 minutes left" near the end (no running clock)
//   after      leaving (or the call ending) goes to the after-session screen
//   group      (0153) a private group (the booker + friends) or an open group's time (opened with { slotId }: the
//              time's ONE room, its view from GET /bookings/groups/:slotId): everyone else as a grid of tiles, each
//              with a first name (an open group's fans join as "Fan"; her app names them from the attendees). Leaving an
//              open group's call goes back to it.
//   tile menu  (0154) long-press a tile (or its ⋯; in a 1:1 the ⋯ on the full-bleed view): Mute · Turn off camera (one
//              tap; they can turn it back on) · Remove from call (confirm) · Block (confirm sheet with the server's
//              preview: out of the call + blocked, upcoming bookings cancelled and refunded). Offered only while the
//              server will accept it. The +15 "hasn't joined" hint shows only on real attendance evidence.
//
// Data: GET …/session (useBookingSession), POST …/session/token (useBookingCall → fetchJoinToken). The join window,
// the grants and "who may join" are the server's; this screen only shows what the server will accept.

import React, { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Button, StackHeader } from "../../components/ui";
import { CallVideo } from "../../components/bookings/CallVideo";
import { ConfirmSheet, refusalLine } from "../../components/bookings/parts";
import { BlockSheet } from "../../components/bookings/BlockSheet";
import { Sheet } from "../../components/ui/Sheet";
import type { RemoteTile } from "../../components/bookings/bookingCall";
import { useBookingSession, useMuteParticipant, useRemoveParticipant, type CallTarget } from "../../hooks/use-booking-session";
import { useGroupSession } from "../../hooks/use-bookings";
import { useBookingCall } from "../../hooks/use-booking-call";
import {
  clock, dayAndTime, errorLine, gridColumns, groupAsSessionView, groupCallControl, isGroupCall, joinBlock, showNoShowHint, tileMenuOptions,
  type GroupCallControl, type TileAction, tileName, timeLeftLine, type AthleteSessionView,
} from "../../lib/bookingSessionLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";

/** A booking's call (1:1 or a private group), or an open group's time (0153). */
export type BookingSessionParams = { bookingId: string; slotId?: undefined } | { slotId: string; bookingId?: undefined };

/** Who she may take out of the call, and how the tiles are named. */
interface GroupCtl extends GroupCallControl { target: CallTarget }

export function BookingSessionScreen() {
  const route = useRoute();
  const navigation = useNavigation<any>();
  const { bookingId, slotId } = (route.params ?? {}) as BookingSessionParams;
  const session = useBookingSession(bookingId ?? "", { enabled: !slotId });
  // An open group's time: opened on it directly, or on one fan's spot (its booking names the time) — either way her
  // tiles are named from the time's attendees.
  const groupSlot = slotId ?? (session.data?.booking.audience === "open_group" ? session.data.booking.slotId ?? null : null);
  const group = useGroupSession(groupSlot, { poll: true });
  const target: CallTarget = slotId ? { slotId } : { bookingId: bookingId! };
  const { call, actions } = useBookingCall(target);

  // Leaving (or the room closing) lands on the after-session screen; an open group's time has its own (Session done
  // there), so its call goes back to it.
  useEffect(() => {
    if (call.status !== "ended") return;
    if (slotId) navigation.goBack(); else navigation.replace("BookingAfter", { bookingId });
  }, [call.status, bookingId, slotId, navigation]);

  const v = slotId ? (group.data ? groupAsSessionView(group.data) : undefined) : session.data;
  const q = slotId ? group : session;
  if (!v) {
    return (
      <SafeAreaView style={styles.safe}>
        <StackHeader title="Booking" bold />
        <View style={styles.center}>
          {q.isError ? (
            <>
              <Text style={styles.body} testID="session-error">{errorLine(q.error)}</Text>
              <Button bold="secondary" onPress={() => q.refetch()} style={styles.gap} testID="session-retry">Try again</Button>
            </>
          ) : <ActivityIndicator color={Bold.ink} testID="session-loading" />}
        </View>
      </SafeAreaView>
    );
  }

  const live = ["permission", "connecting", "waiting", "in_call", "reconnecting"].includes(call.status);
  // Who she may act on (Mute · Turn off camera · Remove · Block), for a group's tiles and a 1:1's one view alike.
  const ctl: GroupCtl = { ...groupCallControl(v, group.data), target };
  if (live) return <CallSurface v={v} call={call} actions={actions} group={isGroupCall(v) ? ctl : null} ctl={ctl} />;
  return <BeforeCall v={v} call={call} onJoin={() => void actions.join()} />;
}

function openLink(url: string | null) {
  if (url) void Linking.openURL(url);
}

function BeforeCall({ v, call, onJoin }: { v: AthleteSessionView; call: ReturnType<typeof useBookingCall>["call"]; onJoin: () => void }) {
  const block = joinBlock(v);
  const backup = v.video.mode === "livekit" ? v.video.fallbackLink : null;
  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title="Booking" bold />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>{v.booking.title}</Text>
        <Text style={styles.title}>{`Call with ${v.booking.buyerName}`}</Text>
        <Text style={styles.meta}>{`${dayAndTime(v.booking.startsAt)} · ${v.booking.durationMinutes} min`}</Text>
        <Text style={styles.meta}>{"Nomila doesn't record calls."}</Text>

        {call.status === "permission_denied" ? (
          <View style={styles.notice} testID="permission-denied">
            <Text style={styles.h4}>Allow camera and microphone</Text>
            <Text style={styles.body}>Allow the camera and microphone for Nomila in Settings so you can be seen and heard.</Text>
            <Button bold="primary" onPress={() => void Linking.openSettings()} style={styles.gap} testID="open-settings">Open Settings</Button>
            <Button bold="secondary" onPress={onJoin} style={styles.gap} testID="permission-retry">Try again</Button>
          </View>
        ) : null}
        {call.status === "error" || call.status === "unsupported" ? (
          <View style={styles.notice} testID="call-error">
            <Text style={styles.body}>{call.status === "unsupported" ? "Join the call from the Nomila app on your phone." : call.error ?? "We couldn't connect."}</Text>
          </View>
        ) : null}

        {block.kind === "button" && call.status !== "permission_denied" && call.status !== "unsupported" ? (
          <>
            <Button bold="primary" onPress={onJoin} disabled={!block.enabled} style={styles.gap} testID="join-call">
              {call.status === "error" ? "Try again" : block.label}
            </Button>
            <Text style={styles.caption}>{"We'll ask for your camera and microphone."}</Text>
          </>
        ) : null}
        {block.kind === "link" ? <Button bold="primary" onPress={() => openLink(block.url)} style={styles.gap} testID="open-call-link">Open the call link</Button> : null}
        {block.kind === "none" ? <Text style={styles.body} testID="join-unavailable">{block.line}</Text> : null}
        {backup ? <Button bold="secondary" onPress={() => openLink(backup)} style={styles.gap} testID="backup-link">Use the backup link</Button> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function CallSurface({ v, call, actions, group, ctl }: {
  v: AthleteSessionView; call: ReturnType<typeof useBookingCall>["call"]; actions: ReturnType<typeof useBookingCall>["actions"]; group: GroupCtl | null; ctl: GroupCtl;
}) {
  const [now, setNow] = useState(Date.now());
  const [menu, setMenu] = useState<{ identity: string; name: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const buyer = v.booking.buyerName;
  const connecting = call.status === "permission" || call.status === "connecting";
  const left = timeLeftLine(v.booking.endsAt, now);
  const noShowHint = showNoShowHint(v, call.remoteJoined, !!group);
  const remotes = call.remotes ?? [];
  // A 1:1's one person: the ⋯ on the full-bleed view opens the same menu as a group tile.
  const one = !group && call.remoteJoined ? remotes[0] : undefined;
  const oneName = one ? tileName(one.identity, one.name, ctl.attendees) : buyer;
  const oneMenu = one && tileMenuOptions(ctl, one.identity).length ? () => { haptics.press(); setMenu({ identity: one.identity, name: oneName }); } : undefined;
  return (
    <View style={styles.call} testID="call-surface">
      <View style={styles.remote}>
        {group && remotes.length ? <RemoteGrid remotes={remotes} group={group} onMenu={setMenu} /> : call.remoteVideo ? <CallVideo track={call.remoteVideo} fit="contain" style={StyleSheet.absoluteFill} zOrder={0} /> : (
          <View style={styles.waiting} testID="call-waiting">
            {connecting ? <ActivityIndicator color={Bold.onDark} /> : null}
            <Text style={styles.callTitle}>{connecting ? "Connecting…" : call.remoteJoined ? buyer : `Waiting for ${buyer}`}</Text>
            {!connecting && !call.remoteJoined ? <Text style={styles.callLine}>{"They'll appear here when they join. Not recorded."}</Text> : null}
          </View>
        )}
        {oneMenu && one ? (
          <Pressable onPress={oneMenu} hitSlop={10} style={styles.oneMenu} accessibilityRole="button" accessibilityLabel={`Options for ${oneName}`} testID={`call-tile-menu-${one.identity}`}>
            <Feather name="more-horizontal" size={18} color={Bold.onDark} />
          </Pressable>
        ) : null}
        {call.localVideo && call.camOn ? (
          <View style={styles.self}><CallVideo track={call.localVideo} mirror={call.facing === "user"} fit="cover" style={StyleSheet.absoluteFill} zOrder={1} /></View>
        ) : null}
        <View style={styles.banners}>
          {call.status === "reconnecting" ? <Text style={styles.banner} testID="call-reconnecting">Reconnecting…</Text> : null}
          {!group && call.remoteLeft && !call.remoteJoined ? <Text style={styles.banner} testID="call-remote-left">{`${buyer} left the call. They can rejoin until ${clock(v.video.joinClosesAt)}.`}</Text> : null}
          {noShowHint ? <Text style={styles.banner} testID="call-noshow-hint">{`${buyer} hasn't joined. It's been 15 minutes. You can leave and mark Buyer didn't show. You'll still be paid.`}</Text> : null}
          {left ? <Text style={styles.banner}>{left}</Text> : null}
          {flash ? <Text style={styles.banner} testID="call-flash">{flash}</Text> : null}
        </View>
      </View>
      <SafeAreaView style={styles.controls}>
        <CallControl icon={call.micOn ? "mic" : "mic-off"} label={call.micOn ? "Mute" : "Unmute"} on={call.micOn} onPress={() => void actions.toggleMic()} testID="call-mic" disabled={connecting} />
        <CallControl icon={call.camOn ? "video" : "video-off"} label={call.camOn ? "Camera off" : "Camera on"} on={call.camOn} onPress={() => void actions.toggleCam()} testID="call-cam" disabled={connecting} />
        <CallControl icon="refresh-cw" label="Flip" on onPress={() => void actions.flip()} testID="call-flip" disabled={connecting || !call.camOn} />
        <CallControl icon="phone-off" label="Leave" on leave onPress={() => void actions.leave()} testID="call-leave" />
      </SafeAreaView>
      {menu ? <TileMenu who={menu} ctl={ctl} onClose={() => setMenu(null)} onFlash={setFlash} /> : null}
    </View>
  );
}

/** Everyone else in a group call, as a grid of tiles (each drawn whole, "contain"), each named. */
function RemoteGrid({ remotes, group, onMenu }: { remotes: RemoteTile[]; group: GroupCtl; onMenu: (who: { identity: string; name: string }) => void }) {
  const cols = gridColumns(remotes.length);
  const rows = Math.ceil(remotes.length / cols);
  const size = { width: `${100 / cols}%` as const, height: `${100 / rows}%` as const };
  return (
    <View style={styles.grid} testID="call-grid">
      {remotes.map((r) => {
        const name = tileName(r.identity, r.name, group.attendees);
        const ask = tileMenuOptions(group, r.identity).length ? () => { haptics.press(); onMenu({ identity: r.identity, name }); } : undefined;
        return (
          <Pressable key={r.identity} onLongPress={ask} delayLongPress={400} style={[styles.tile, size]} accessibilityLabel={name}
            accessibilityHint={ask ? "Long-press for options" : undefined} testID={`call-tile-${r.identity}`}>
            {r.video ? <CallVideo track={r.video} fit="contain" style={StyleSheet.absoluteFill} zOrder={0} /> : (
              <View style={styles.tileBlank}><Text style={styles.tileInitial}>{name.slice(0, 1).toUpperCase()}</Text></View>
            )}
            <Text style={styles.tileName} numberOfLines={1} testID={`call-tile-name-${r.identity}`}>{name}</Text>
            {ask ? (
              <Pressable onPress={ask} hitSlop={10} style={styles.tileMenu} accessibilityRole="button" accessibilityLabel={`Options for ${name}`} testID={`call-tile-menu-${r.identity}`}>
                <Feather name="more-horizontal" size={16} color={Bold.onDark} />
              </Pressable>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Her menu on one person (0154): Mute and Turn off camera are one tap (harmless; they can turn it back on), Remove and
 * Block each open their own confirm sheet. Every row is a 44pt+ target.
 */
function TileMenu({ who, ctl, onClose, onFlash }: { who: { identity: string; name: string }; ctl: GroupCtl; onClose: () => void; onFlash: (line: string | null) => void }) {
  const [step, setStep] = useState<"menu" | "remove" | "block">("menu");
  const mute = useMuteParticipant(ctl.target);
  const [error, setError] = useState<string | null>(null);
  const pick = (k: TileAction) => {
    if (k === "remove" || k === "block") { setStep(k); return; }
    setError(null);
    mute.mutate({ identity: who.identity, track: k === "mute" ? "microphone" : "camera" }, {
      onSuccess: (r) => {
        haptics.success();
        onFlash(r.outcome === "not_in_call" ? `${who.name} isn't in the call.` : k === "mute" ? `You muted ${who.name}. They can unmute themselves.` : `You turned off ${who.name}'s camera. They can turn it back on.`);
        onClose();
      },
      onError: (err) => setError(refusalLine(err, k === "mute" ? "Couldn't mute them. Try again." : "Couldn't turn off their camera. Try again.")),
    });
  };
  if (step === "remove") return <RemoveSheet who={who} target={ctl.target} onClose={onClose} />;
  if (step === "block") {
    return <BlockSheet target={ctl.target} identity={who.identity} name={who.name} inCall onClose={onClose}
      onDone={() => { onFlash(`${who.name} is blocked and out of the call.`); onClose(); }} testID="block-sheet" />;
  }
  return (
    <Sheet onClose={onClose} title={who.name}>
      <View style={styles.menu} testID="tile-menu">
        {tileMenuOptions(ctl, who.identity).map((o) => (
          <Pressable key={o.key} onPress={() => pick(o.key)} disabled={mute.isPending} accessibilityRole="button" accessibilityLabel={o.label}
            style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]} testID={`tile-menu-${o.key}`}>
            <Feather name={o.key === "mute" ? "mic-off" : o.key === "camera" ? "video-off" : o.key === "remove" ? "log-out" : "slash"} size={18} color={Bold.ink} />
            <Text style={styles.menuText}>{o.label}</Text>
          </Pressable>
        ))}
        {error ? <Text style={styles.body} testID="tile-menu-error">{error}</Text> : null}
      </View>
    </Sheet>
  );
}

function RemoveSheet({ who, target, onClose }: { who: { identity: string; name: string }; target: CallTarget; onClose: () => void }) {
  const remove = useRemoveParticipant(target);
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    setError(null);
    remove.mutate(who.identity, {
      onSuccess: () => { haptics.success(); onClose(); },
      onError: (err) => setError(refusalLine(err, "Couldn't remove them. Try again.")),
    });
  };
  return (
    <ConfirmSheet title={`Remove ${who.name} from the call?`} confirm={`Remove ${who.name}`} cancelLabel="Keep them" onConfirm={confirm} onClose={onClose}
      busy={remove.isPending} error={error} testID="remove-sheet">
      <Text style={styles.body}>{`${who.name} leaves the call now and can't rejoin it. If something happened, report it from the booking after the call.`}</Text>
    </ConfirmSheet>
  );
}

function CallControl({ icon, label, on, leave, disabled, onPress, testID }: { icon: React.ComponentProps<typeof Feather>["name"]; label: string; on: boolean; leave?: boolean; disabled?: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: on }}
      style={({ pressed }) => [styles.control, leave && styles.controlLeave, !on && styles.controlOff, disabled && styles.controlDisabled, pressed && styles.pressed]}
      testID={testID}
    >
      <Feather name={icon} size={20} color={leave ? Bold.ink : Bold.onDark} />
      <Text style={[styles.controlText, leave && styles.controlTextLeave]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: Bold.paper },
  center:   { flex: 1, alignItems: "center", justifyContent: "center", padding: Bold.gutter },
  content:  { padding: Bold.gutter, paddingBottom: 40 },
  eyebrow:  { ...BoldType.label, color: Bold.mute, marginBottom: 8 },
  title:    { ...BoldType.screenTitleSm, color: Bold.ink, marginBottom: 8 },
  meta:     { ...BoldType.rowMeta, color: Bold.mute, marginBottom: 4 },
  body:     { ...BoldType.body, color: Bold.ink2 },
  h4:       { ...BoldType.h4, color: Bold.ink, marginBottom: 4 },
  caption:  { ...BoldType.caption, color: Bold.mute, marginTop: 8 },
  gap:      { marginTop: 12 },
  notice:   { borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, padding: 14, marginTop: 16 },
  call:     { flex: 1, backgroundColor: Bold.ink },
  remote:   { flex: 1 },
  grid:     { flex: 1, flexDirection: "row", flexWrap: "wrap" },
  tile:     { borderWidth: 1, borderColor: Bold.ink, backgroundColor: Bold.heroBlank, overflow: "hidden" },
  tileBlank: { flex: 1, alignItems: "center", justifyContent: "center" },
  tileInitial: { ...BoldType.bannerTitle, color: Bold.onDark },
  tileName: { ...BoldType.caption, position: "absolute", left: 8, bottom: 8, maxWidth: "80%", color: Bold.onDark, backgroundColor: "rgba(0,0,0,0.66)", borderRadius: Bold.radius.chip, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  tileMenu: { position: "absolute", top: 8, right: 8, width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.66)" },
  oneMenu:  { position: "absolute", top: 12, right: 12, width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.66)" },
  menu:     { gap: 4, paddingBottom: 8 },
  menuRow:  { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, borderBottomWidth: 1, borderBottomColor: Bold.line },
  menuText: { ...BoldType.rowTitle, color: Bold.ink },
  waiting:  { flex: 1, alignItems: "center", justifyContent: "center", padding: Bold.gutter },
  callTitle: { ...BoldType.bannerTitle, color: Bold.onDark, marginTop: 12, textAlign: "center" },
  callLine: { ...BoldType.caption, color: Bold.onDarkLabel, marginTop: 6, textAlign: "center" },
  self:     { position: "absolute", right: 12, bottom: 12, width: 108, height: 144, borderRadius: Bold.radius.card, overflow: "hidden", borderWidth: 1, borderColor: Bold.lineOnDark, backgroundColor: Bold.heroBlank },
  banners:  { position: "absolute", top: 56, left: 12, right: 12 },
  banner:   { ...BoldType.caption, color: Bold.onDark, backgroundColor: "rgba(0,0,0,0.66)", borderColor: "rgba(255,255,255,0.16)", borderWidth: 1, borderRadius: Bold.radius.card, padding: 10, marginBottom: 8, overflow: "hidden" },
  controls: { flexDirection: "row", gap: 8, paddingHorizontal: Bold.gutter, paddingVertical: 12 },
  control:  { flex: 1, minHeight: Bold.button + 8, borderRadius: Bold.radius.control, borderWidth: 1.5, borderColor: Bold.onDarkLabel, alignItems: "center", justifyContent: "center", gap: 4 },
  controlOff: { borderColor: Bold.lineOnDark },
  controlLeave: { backgroundColor: Bold.onDark, borderColor: Bold.onDark },
  controlDisabled: { opacity: 0.4 },
  controlText: { ...BoldType.buttonSmall, color: Bold.onDark },
  controlTextLeave: { color: Bold.ink },
  pressed:  { transform: [{ scale: Bold.pressScale }] },
});
