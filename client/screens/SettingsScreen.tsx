import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  SafeAreaView,
  StatusBar,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "../lib/auth-context";
import { haptics } from "../lib/haptics";
import { useConnections, type Connection } from "../hooks/use-connections";
import { usePlatformOAuth } from "../hooks/use-platform-oauth";
import { useDealPreferences, useUpdatePreferences } from "../hooks/use-deals";
import { apiRequest } from "../lib/query-client";
import { PlatformIcon } from "../components/PlatformIcon";
import { StackHeader } from "../components/ui";
import { openRates } from "../navigation/meNav";
import { OPPS_V2 } from "../lib/flags";
import { Colors, Fonts, Spacing, BorderRadius, Bold } from "../constants/theme";
import { NotificationSettings } from "../components/settings/NotificationSettings";
import { settingsRow as bt } from "../components/settings/settingsRow";
import { ExportDataSheet } from "../components/settings/ExportDataSheet";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const INBOX_PROVIDERS = [
  { platform: "gmail",   label: "Gmail",   color: "#EA4335", enabled: true  },
  { platform: "outlook", label: "Outlook", color: "#0078D4", enabled: true  },
];

const SOCIAL_PLATFORMS = [
  { platform: "instagram", label: "Instagram", color: "#E1306C" },
  { platform: "youtube",   label: "YouTube",   color: "#FF0000" },
  { platform: "tiktok",    label: "TikTok",    color: "#010101" },
  // Spotify is hidden for now (owner, 23 Oct 2026); its connector stays in server/lib/integrations/registry.ts.
];

const ALIAS_PRESETS = ["Personal", "Business", "Work", "Agency"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAgo(dateStr: string | null): string {
  if (!dateStr) return "";
  const diff  = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60_000);
  if (mins < 2)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days  = Math.floor(diff / 86_400_000);
  if (days < 30)  return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Sort: Gmail active → Gmail revoked/pending → Outlook active → Outlook revoked/pending
function sortInbox(connections: Connection[]): Connection[] {
  const providerOrder = (c: Connection) => c.platform === "gmail" ? 0 : 1;
  const statusOrder   = (c: Connection) =>
    c.status === "active" ? 0 : c.status === "pending" ? 1 : 2;
  return [...connections].sort((a, b) =>
    providerOrder(a) !== providerOrder(b)
      ? providerOrder(a) - providerOrder(b)
      : statusOrder(a) - statusOrder(b),
  );
}

// ─── CollapsibleSection ───────────────────────────────────────────────────────

function CollapsibleSection({
  icon, title, subtitle, defaultExpanded = false, children,
}: {
  icon:             React.ComponentProps<typeof Feather>["name"];
  title:            string;
  subtitle:         string;
  defaultExpanded?: boolean;
  children:         React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultExpanded);

  function toggle() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((v) => !v);
  }

  return (
    <View style={styles.section}>
      <Pressable style={styles.sectionHeader} onPress={toggle}>
        <View style={styles.sectionIconWrap}>
          <Feather name={icon} size={18} color={Colors.light.primary} />
        </View>
        <View style={styles.sectionHeaderText}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.sectionSubtitle}>{subtitle}</Text>
        </View>
        <Feather name={open ? "chevron-up" : "chevron-down"} size={18} color={Bold.quiet} />
      </Pressable>
      {open && <View style={styles.sectionBody}>{children}</View>}
    </View>
  );
}

// ─── InboxAccountRow ──────────────────────────────────────────────────────────

function InboxAccountRow({
  connection,
  platform,
  providerColor,
  onRefresh,
}: {
  connection:    Connection;
  platform:      string;
  providerColor: string;
  onRefresh:     () => void;
}) {
  const { connect, disconnect, connecting } = usePlatformOAuth(connection.platform);

  const [showActions,        setShowActions]        = useState(false);
  const [confirmDisconnect,  setConfirmDisconnect]  = useState(false);
  const [editingAlias,       setEditingAlias]       = useState(false);
  const [aliasInput,         setAliasInput]         = useState(connection.alias ?? "");
  const [saving,             setSaving]             = useState(false);
  const inputRef = useRef<TextInput>(null);

  const isActive  = connection.status === "active";
  // A failed Gmail token refresh sets status "expired"; social revocation sets
  // "revoked". Both surface identically here (Expired badge + Reconnect action).
  const isRevoked = connection.status === "revoked" || connection.status === "expired";
  const isPending = connection.status === "pending";
  const noAlias   = isActive && !connection.alias;

  const email       = connection.platform_username ?? "";
  const primaryText = connection.alias ?? (isPending ? "Connecting…" : email);
  const secondaryText = connection.alias ? email : null;

  async function handleSetAlias(alias: string) {
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/v1/me/connections/${connection.id}`, { alias });
      onRefresh();
    } finally {
      setSaving(false);
      setEditingAlias(false);
    }
  }

  function startRename() {
    setShowActions(false);
    setAliasInput(connection.alias ?? "");
    setEditingAlias(true);
    setTimeout(() => inputRef.current?.focus(), 80);
  }

  return (
    <View>
      {/* ── Main row ─────────────────────────────────────────────────────── */}
      <View style={styles.inboxRow}>
        {/* Provider icon */}
        <PlatformIcon platform={platform} color={providerColor} size={22} />

        {/* Text block — alias on line 1, email on line 2 */}
        <View style={styles.inboxRowTextBlock}>
          <Text style={styles.inboxRowPrimary} numberOfLines={1}>
            {primaryText || "—"}
          </Text>
          {secondaryText ? (
            <Text style={styles.inboxRowSecondary} numberOfLines={1}>
              {secondaryText}
            </Text>
          ) : null}
        </View>

        {/* Status */}
        {isActive && (
          <View style={styles.activeBadge}>
            <Feather name="check" size={10} color={Bold.ink} />
            <Text style={styles.activeBadgeText}>Active</Text>
          </View>
        )}
        {isRevoked && (
          <View style={styles.revokedBadge}>
            <Feather name="alert-circle" size={10} color={Colors.light.warning} />
            <Text style={styles.revokedBadgeText}>Expired</Text>
          </View>
        )}
        {isPending && (
          <ActivityIndicator
            size="small"
            color={Bold.quiet}
            style={{ transform: [{ scale: 0.75 }] }}
          />
        )}

        {/* Action */}
        {isRevoked && (
          <Pressable
            style={[styles.reconnectInline, connecting && { opacity: 0.5 }]}
            onPress={async () => { await connect(connection.alias ?? undefined, email || undefined); onRefresh(); }}
            disabled={connecting}
          >
            {connecting
              ? <ActivityIndicator size="small" color={Colors.light.primary} style={{ transform: [{ scale: 0.75 }] }} />
              : <Text style={styles.reconnectInlineText}>Reconnect</Text>}
          </Pressable>
        )}
        {isPending && (
          <Pressable hitSlop={10} onPress={() => { disconnect(connection.id); onRefresh(); }}>
            <Feather name="x" size={14} color={Bold.quiet} />
          </Pressable>
        )}
        {isActive && (
          <Pressable
            hitSlop={10}
            onPress={() => { setShowActions((v) => !v); setConfirmDisconnect(false); }}
          >
            <Feather name="more-horizontal" size={18} color={Bold.quiet} />
          </Pressable>
        )}
      </View>

      {/* ── Alias preset picker (no alias yet) ──────────────────────────── */}
      {noAlias && !editingAlias && (
        <View style={styles.aliasPicker}>
          <Text style={styles.aliasPickerLabel}>Label this inbox:</Text>
          <View style={styles.aliasPresets}>
            {ALIAS_PRESETS.map((p) => (
              <Pressable key={p} style={styles.aliasPresetChip} onPress={() => handleSetAlias(p)}>
                <Text style={styles.aliasPresetText}>{p}</Text>
              </Pressable>
            ))}
            <Pressable
              style={styles.aliasPresetChip}
              onPress={() => { setAliasInput(""); setEditingAlias(true); }}
            >
              <Text style={styles.aliasPresetText}>Custom…</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* ── Inline alias edit ────────────────────────────────────────────── */}
      {editingAlias && (
        <View style={styles.aliasEditRow}>
          <TextInput
            ref={inputRef}
            style={styles.aliasEditInput}
            value={aliasInput}
            onChangeText={setAliasInput}
            placeholder="Label (e.g. Business)"
            placeholderTextColor="#AAAAAA"
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => handleSetAlias(aliasInput)}
          />
          <Pressable
            style={[styles.aliasSaveBtn, saving && { opacity: 0.5 }]}
            onPress={() => handleSetAlias(aliasInput)}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.aliasSaveBtnText}>Save</Text>}
          </Pressable>
          <Pressable hitSlop={8} onPress={() => setEditingAlias(false)}>
            <Feather name="x" size={15} color={Bold.quiet} />
          </Pressable>
        </View>
      )}

      {/* ── Inline actions panel (···) ───────────────────────────────────── */}
      {showActions && (
        <View style={styles.actionsPanel}>
          {!confirmDisconnect ? (
            <>
              <Pressable style={styles.actionRow} onPress={startRename}>
                <Feather name="edit-2" size={13} color={Colors.light.textSecondary} />
                <Text style={styles.actionRowText}>Rename label</Text>
              </Pressable>
              <View style={styles.actionDivider} />
              <Pressable style={styles.actionRow} onPress={() => setConfirmDisconnect(true)}>
                <Feather name="trash-2" size={13} color={Colors.light.error} />
                <Text style={[styles.actionRowText, { color: Colors.light.error }]}>Disconnect</Text>
              </Pressable>
            </>
          ) : (
            <View style={styles.confirmRow}>
              <Text style={styles.confirmText}>Remove {email}?</Text>
              <View style={styles.confirmBtns}>
                <Pressable
                  style={styles.confirmCancel}
                  onPress={() => { setConfirmDisconnect(false); setShowActions(false); }}
                >
                  <Text style={styles.confirmCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={styles.confirmRemove}
                  onPress={async () => { await disconnect(connection.id); onRefresh(); }}
                >
                  <Text style={styles.confirmRemoveText}>Remove</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ─── AddInboxPicker ───────────────────────────────────────────────────────────

function AddInboxPicker({ onRefresh }: { onRefresh: () => void }) {
  const { athlete } = useAuth();
  const [open, setOpen] = useState(false);
  const { connect: gmailConnect,   connecting: gmailConnecting }   = usePlatformOAuth("gmail");
  const { connect: outlookConnect, connecting: outlookConnecting } = usePlatformOAuth("outlook");
  const [awaitingEmail, setAwaitingEmail] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const emailRef = useRef<TextInput>(null);

  function onSelectGmail() {
    setOpen(false);
    setEmailInput(athlete?.email ?? "");
    setAwaitingEmail(true);
    setTimeout(() => emailRef.current?.focus(), 80);
  }

  const trimmedEmail = emailInput.trim();
  const emailValid   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);

  async function onConfirmEmail() {
    if (!emailValid) return;
    setAwaitingEmail(false);
    await gmailConnect(undefined, trimmedEmail);
    onRefresh();
  }

  async function onSelectOutlook() {
    setOpen(false);
    await outlookConnect();
    onRefresh();
  }

  function onCancelEmail() {
    setAwaitingEmail(false);
    setEmailInput("");
  }

  // Email confirmation step — shown after selecting Gmail, before OAuth redirect
  if (awaitingEmail) {
    return (
      <View style={styles.emailConfirmRow}>
        <TextInput
          ref={emailRef}
          style={styles.emailConfirmInput}
          value={emailInput}
          onChangeText={setEmailInput}
          placeholder="Gmail address to connect"
          placeholderTextColor="#AAAAAA"
          autoCapitalize="none"
          keyboardType="email-address"
          returnKeyType="go"
          onSubmitEditing={onConfirmEmail}
        />
        <Pressable
          style={[styles.emailConfirmBtn, (gmailConnecting || !emailValid) && { opacity: 0.5 }]}
          onPress={() => { haptics.press(); onConfirmEmail(); }}
          disabled={gmailConnecting || !emailValid}
        >
          {gmailConnecting
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.emailConfirmBtnText}>Connect</Text>}
        </Pressable>
        <Pressable hitSlop={8} onPress={onCancelEmail}>
          <Feather name="x" size={15} color={Bold.quiet} />
        </Pressable>
      </View>
    );
  }

  if (!open) {
    return (
      <Pressable style={styles.addBtn} onPress={() => setOpen(true)}>
        <Feather name="plus" size={12} color={Colors.light.primary} />
        <Text style={styles.addBtnText}>Add</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.addPickerOpen}>
      <Pressable
        style={styles.addPickerChip}
        onPress={onSelectGmail}
      >
        <PlatformIcon platform="gmail" color="#EA4335" size={14} />
        <Text style={styles.addPickerChipText}>Gmail</Text>
      </Pressable>

      <Pressable
        style={[styles.addPickerChip, outlookConnecting && { opacity: 0.5 }]}
        onPress={onSelectOutlook}
        disabled={outlookConnecting}
      >
        {outlookConnecting
          ? <ActivityIndicator size="small" color="#0078D4" style={{ transform: [{ scale: 0.7 }] }} />
          : <PlatformIcon platform="outlook" color="#0078D4" size={14} />}
        <Text style={styles.addPickerChipText}>Outlook</Text>
      </Pressable>

      <Pressable hitSlop={10} onPress={() => setOpen(false)}>
        <Feather name="x" size={15} color={Bold.quiet} />
      </Pressable>
    </View>
  );
}

// ─── SocialPlatformRow ────────────────────────────────────────────────────────

function SocialPlatformRow({
  platform, label, color, connections, onRefresh,
}: {
  platform:    string;
  label:       string;
  color:       string;
  connections: Connection[];
  onRefresh:   () => void;
}) {
  const { connect, disconnect, connecting } = usePlatformOAuth(platform);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const active = connections.filter((c) => c.status === "active");
  // Prefer an active connection; else surface a lingering expired/pending one so the row shows its
  // real state (Reconnect / Connecting…) and lets the athlete remove it — instead of it silently
  // reading as "Active" or vanishing.
  const conn   = active[0] ?? connections.find((c) => c.status !== "revoked") ?? null;
  const status = conn?.status ?? null;
  const handle = conn?.platform_username ?? null;

  async function onConnect() { await connect(); onRefresh(); }

  async function onDisconnect() {
    if (!conn) return;
    if (confirmDisconnect) {
      await disconnect(conn.id);
      setConfirmDisconnect(false);
      onRefresh();
    } else {
      setConfirmDisconnect(true);
    }
  }

  return (
    <View style={styles.socialRow}>
      <View style={[styles.socialIconWrap, { backgroundColor: color + "18" }]}>
        <PlatformIcon platform={platform} color={color} size={22} />
      </View>
      <View style={styles.socialRowMid}>
        <Text style={styles.socialRowLabel}>{label}</Text>
        {handle && <Text style={styles.socialRowHandle} numberOfLines={1}>{handle}</Text>}
      </View>
      {conn ? (
        <View style={styles.socialRowRight}>
          {!confirmDisconnect ? (
            <>
              {status === "active" ? (
                <View style={styles.activeBadge}>
                  <Feather name="check" size={10} color={Bold.ink} />
                  <Text style={styles.activeBadgeText}>Active</Text>
                </View>
              ) : status === "pending" ? (
                <View style={styles.pendingBadge}><Text style={styles.pendingBadgeText}>Connecting…</Text></View>
              ) : (
                <View style={styles.expiredBadge}><Text style={styles.expiredBadgeText}>Expired</Text></View>
              )}
              {status !== "active" && status !== "pending" ? (
                <Pressable style={styles.reconnectBtn} onPress={onConnect} disabled={connecting}>
                  {connecting ? <ActivityIndicator size="small" color={Colors.light.primary} /> : <Text style={styles.reconnectBtnText}>Reconnect</Text>}
                </Pressable>
              ) : null}
              <Pressable hitSlop={8} onPress={onDisconnect}>
                <Feather name="x" size={14} color={Bold.quiet} />
              </Pressable>
            </>
          ) : (
            <>
              <Pressable style={styles.confirmCancel} onPress={() => setConfirmDisconnect(false)}>
                <Text style={styles.confirmCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.confirmRemove} onPress={onDisconnect}>
                <Text style={styles.confirmRemoveText}>Remove</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : (
        <Pressable
          style={[styles.connectBtn, connecting && { opacity: 0.5 }]}
          onPress={() => { haptics.press(); onConnect(); }}
          disabled={connecting}
        >
          {connecting
            ? <ActivityIndicator size="small" color={Colors.light.buttonText} />
            : <Text style={styles.connectBtnText}>Connect</Text>}
        </Pressable>
      )}
    </View>
  );
}

// ─── SettingsScreen ───────────────────────────────────────────────────────────

export function SettingsScreen() {
  const navigation = useNavigation<any>();
  const { athlete, signOut } = useAuth();
  // Settings is pushed from the top bar's gear and from Me (a back chevron). One layout since stage 1 (owner, 25 Oct
  // 2026): the Classic layout switch and its Settings tab are gone.
  const pushed = navigation.getState?.()?.type === "stack";
  const { connections, forPlatform, isLoading, refetch } = useConnections();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // Deal Preferences — sign-off names used when drafting as the team ("Send as → My team")
  const { data: prefsData } = useDealPreferences();
  const updatePrefs = useUpdatePreferences();
  const [agentInput, setAgentInput]   = useState("");
  const [agencyInput, setAgencyInput] = useState("");
  // OPPS_V2 (D2): her business team member is a name AND a role; "Send as my team" appears only once a name is set.
  const [roleInput, setRoleInput]     = useState("");
  const [prefsSaved, setPrefsSaved]   = useState(false);
  const agentInputRef = useRef<TextInput>(null);
  const savedTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const p = prefsData?.deal_preferences;
    if (p) {
      setAgentInput(p.agent_name ?? "");
      setAgencyInput(p.agency_name ?? "");
      setRoleInput(p.agent_role ?? "");
    }
  }, [prefsData]);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const savedAgent  = (prefsData?.deal_preferences?.agent_name ?? "").trim();
  const savedAgency = (prefsData?.deal_preferences?.agency_name ?? "").trim();
  const savedRole   = (prefsData?.deal_preferences?.agent_role ?? "").trim();
  const prefsDirty  = OPPS_V2
    ? agentInput.trim() !== savedAgent || roleInput.trim() !== savedRole
    : agentInput.trim() !== savedAgent || agencyInput.trim() !== savedAgency;

  async function handleSavePrefs() {
    if (updatePrefs.isPending) return;
    if (!prefsDirty) { agentInputRef.current?.focus(); return; } // "Edit" — jump into the field
    try {
      await updatePrefs.mutateAsync(OPPS_V2
        ? { agent_name: agentInput.trim(), agent_role: roleInput.trim() }
        : { agent_name: agentInput.trim(), agency_name: agencyInput.trim() });
      setPrefsSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setPrefsSaved(false), 1600);
    } catch {
      // leave the button in its unsaved state so the user can retry
    }
  }

  const handleRefresh = useCallback(() => { refetch(); }, [refetch]);

  // All inbox connections (Gmail + Outlook), sorted
  const inboxConnections = sortInbox(
    connections.filter((c) => c.platform === "gmail" || c.platform === "outlook"),
  );

  const hasAnyInbox = inboxConnections.length > 0;

  function providerMeta(platform: string) {
    return INBOX_PROVIDERS.find((p) => p.platform === platform)
      ?? { icon: "email" as const, color: Bold.quiet };
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.light.backgroundRoot} />

      {pushed ? <StackHeader title="Settings" /> : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header, when not pushed on a stack. */}
        {!pushed ? (
          <View style={styles.header}>
            <Text style={styles.screenTitle}>Settings</Text>
          </View>
        ) : null}

        {/* Profile summary */}
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(athlete?.firstName?.[0] ?? athlete?.email?.[0] ?? "?").toUpperCase()}
            </Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>
              {[athlete?.firstName, athlete?.lastName].filter(Boolean).join(" ") || "Athlete"}
            </Text>
            <Text style={styles.profileEmail}>{athlete?.email ?? ""}</Text>
          </View>
        </View>

        {/* ── YOUR FLOOR — lives under Brand › Rates; this row is the door ── */}
        <Pressable style={bt.row} onPress={() => openRates(navigation)} accessibilityRole="button">
          <View style={bt.iconWrap}>
            <Feather name="dollar-sign" size={18} color={Colors.light.primary} />
          </View>
          <View style={bt.text}>
            <Text style={bt.title}>{OPPS_V2 ? "Your rates" : "Your floor"}</Text>
            <Text style={bt.sub}>{OPPS_V2 ? "Mila suggests. You set your minimum." : "The least you'll take, per deal type"}</Text>
          </View>
          <Feather name="chevron-right" size={18} color={Bold.quiet} />
        </Pressable>

        {/* ── CONNECTIONS ─────────────────────────────────────────────────────── */}
        <CollapsibleSection
          icon="link-2"
          title="Connections"
          subtitle="Inboxes and social accounts"
        >
          {isLoading ? (
            <ActivityIndicator color={Colors.light.primary} style={{ marginVertical: Spacing.xl }} />
          ) : (
            <View style={styles.connectionsBody}>

              {/* INBOX ─────────────────────────────────────────────────────── */}
              <View style={styles.inboxHeader}>
                <Text style={styles.subSectionLabel}>INBOX</Text>
                <AddInboxPicker onRefresh={handleRefresh} />
              </View>

              <View style={[styles.inboxList, hasAnyInbox && styles.inboxListBordered]}>
                {hasAnyInbox ? (
                  inboxConnections.map((c, i) => (
                    <View
                      key={c.id}
                      style={[
                        styles.inboxListItem,
                        i > 0 && styles.inboxListItemBorder,
                      ]}
                    >
                      <InboxAccountRow
                        connection={c}
                        platform={c.platform}
                        providerColor={providerMeta(c.platform).color}
                        onRefresh={handleRefresh}
                      />
                    </View>
                  ))
                ) : (
                  <Text style={styles.inboxEmptyText}>
                    No inboxes connected — tap Add to get started
                  </Text>
                )}
              </View>

              {/* SOCIAL ─────────────────────────────────────────────────────── */}
              <Text style={[styles.subSectionLabel, { marginTop: Spacing.xl }]}>SOCIAL</Text>
              <View style={styles.socialSection}>
                {SOCIAL_PLATFORMS.map((p) => (
                  <SocialPlatformRow
                    key={p.platform}
                    platform={p.platform}
                    label={p.label}
                    color={p.color}
                    connections={forPlatform(p.platform)}
                    onRefresh={handleRefresh}
                  />
                ))}
              </View>
            </View>
          )}
        </CollapsibleSection>

        {/* ── DEAL PREFERENCES ────────────────────────────────────────────────── */}
        <CollapsibleSection
          icon="target"
          title={OPPS_V2 ? "Your business team" : "Deal Preferences"}
          subtitle={OPPS_V2 ? "Someone who can sign replies for you" : "Sign-off names for team-voice drafts"}
        >
          <View style={styles.dealPrefsBody}>
            <Text style={styles.dealPrefsHint}>
              {OPPS_V2
                ? "Replies are signed as you. Add the person who helps with your deals and you can choose to send as them. Leave it empty and nothing changes."
                : 'Used when you draft replies as your team ("Send as → My team"). These names appear in the sign-off.'}
            </Text>

            <Text style={styles.dealPrefsLabel}>{OPPS_V2 ? "Their name" : "Agent name (optional)"}</Text>
            <TextInput
              ref={agentInputRef}
              style={styles.dealPrefsInput}
              value={agentInput}
              onChangeText={setAgentInput}
              placeholder="e.g. Alex Chen"
              placeholderTextColor="#AAAAAA"
              autoCapitalize="words"
              returnKeyType="done"
            />

            {OPPS_V2 ? (
              <>
                <Text style={styles.dealPrefsLabel}>Their role</Text>
                <TextInput
                  style={styles.dealPrefsInput}
                  value={roleInput}
                  onChangeText={setRoleInput}
                  placeholder="e.g. Manager, Parent, Agent"
                  placeholderTextColor="#AAAAAA"
                  autoCapitalize="words"
                  returnKeyType="done"
                  accessibilityLabel="Their role"
                  testID="settings-team-role"
                />
              </>
            ) : (
              <>
            <Text style={styles.dealPrefsLabel}>Agency name</Text>
            <TextInput
              style={styles.dealPrefsInput}
              value={agencyInput}
              onChangeText={setAgencyInput}
              placeholder={`${athlete?.lastName ?? "Your last name"} Management`}
              placeholderTextColor="#AAAAAA"
              autoCapitalize="words"
              returnKeyType="done"
            />
              </>
            )}

            <Pressable
              style={[
                styles.dealPrefsBtn,
                prefsSaved ? styles.dealPrefsBtnSaved : prefsDirty ? styles.dealPrefsBtnActive : styles.dealPrefsBtnMuted,
                updatePrefs.isPending && { opacity: 0.6 },
              ]}
              onPress={() => { haptics.press(); handleSavePrefs(); }}
              disabled={updatePrefs.isPending}
            >
              {updatePrefs.isPending ? (
                <ActivityIndicator size="small" color={Colors.light.buttonText} />
              ) : prefsSaved ? (
                <>
                  <Feather name="check" size={15} color={Colors.light.buttonText} />
                  <Text style={styles.dealPrefsBtnText}>Saved</Text>
                </>
              ) : (
                <Text style={[styles.dealPrefsBtnText, !prefsDirty && styles.dealPrefsBtnTextMuted]}>
                  {prefsDirty ? "Save" : "Edit"}
                </Text>
              )}
            </Pressable>
          </View>
        </CollapsibleSection>

        {/* ── NOTIFICATIONS — what Nomila tells her phone (server/services/push) ── */}
        <CollapsibleSection icon="bell" title="Notifications" subtitle="What Nomila tells your phone">
          <NotificationSettings />
        </CollapsibleSection>

        {/* ── ACCOUNT ─────────────────────────────────────────────────────────── */}
        {/* Download your data · Sign out · Delete account (App Review looks for deletion here; the header says so). */}
        <CollapsibleSection
          icon="user"
          title="Account"
          subtitle="Your data, sign out, delete account"
        >
          <AccountRow
            icon="download"
            title="Download your data"
            sub="A copy of everything Nomila holds about you"
            onPress={() => setExportOpen(true)}
            first
            testID="settings-download-data"
          />
          <View style={styles.accountBody}>
            {!confirmSignOut ? (
              <Pressable style={styles.signOutBtn} onPress={() => setConfirmSignOut(true)}>
                <Feather name="log-out" size={16} color={Colors.light.error} />
                <Text style={styles.signOutText}>Sign out</Text>
              </Pressable>
            ) : (
              <View style={styles.confirmRow}>
                <Text style={styles.confirmText}>Sign out of Nomila?</Text>
                <View style={styles.confirmBtns}>
                  <Pressable style={styles.confirmCancel} onPress={() => setConfirmSignOut(false)}>
                    <Text style={styles.confirmCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={styles.confirmRemove} onPress={signOut}>
                    <Text style={styles.confirmRemoveText}>Sign out</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
          <AccountRow
            icon="trash-2"
            title="Delete account"
            sub="Closes your account and erases your data"
            danger
            onPress={() => navigation.navigate("DeleteAccount")}
            testID="settings-delete-account"
          />
        </CollapsibleSection>

        <View style={styles.bottomPad} />
      </ScrollView>
      {exportOpen && <ExportDataSheet onClose={() => setExportOpen(false)} />}
    </SafeAreaView>
  );
}

/** A row inside Account: grey tile, title, line, chevron (the SheetDoor shape); `danger` is the error red. */
function AccountRow({ icon, title, sub, danger, first, onPress, testID }: {
  icon: React.ComponentProps<typeof Feather>["name"]; title: string; sub: string; danger?: boolean; first?: boolean; onPress: () => void; testID?: string;
}) {
  const ink = danger ? Colors.light.error : Colors.light.text;
  return (
    <Pressable style={[styles.accountRow, first && styles.accountRowFirst]} onPress={() => { haptics.press(); onPress(); }} accessibilityRole="button" testID={testID}>
      <View style={styles.accountTile}><Feather name={icon} size={17} color={ink} /></View>
      <View style={styles.accountRowText}>
        <Text style={[styles.accountRowTitle, { color: ink }]}>{title}</Text>
        <Text style={styles.accountRowSub}>{sub}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={Bold.quiet} />
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  scroll:  { flex: 1 },
  content: { paddingBottom: Spacing["4xl"] },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: Spacing.xl,
    paddingTop:        Spacing.lg,
    paddingBottom:     Spacing.sm,
  },
  screenTitle: {
    fontFamily:    Fonts.heading,
    fontSize:      26,
    color:         Colors.light.text,
    letterSpacing: -0.5,
  },

  // Profile
  profileRow: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingVertical:   Spacing.lg,
    marginBottom:      Spacing.sm,
  },
  avatar: {
    width:           48,
    height:          48,
    borderRadius:    24,
    backgroundColor: Colors.light.primary + "20",
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarText: {
    fontFamily: Fonts.heading,
    fontSize:   20,
    color:      Colors.light.primary,
  },
  profileInfo:  { flex: 1 },
  profileName:  { fontFamily: Fonts.bodySemiBold, fontSize: 16, color: Colors.light.text },
  profileEmail: { fontFamily: Fonts.body, fontSize: 13, color: Bold.quiet, marginTop: 2 },

  // Collapsible section
  section: {
    marginHorizontal: Spacing.xl,
    marginBottom:     Spacing.sm,
    backgroundColor:  Colors.light.card,
    borderRadius:     BorderRadius.sm,
    overflow:         "hidden",
    shadowColor:      "#000",
    shadowOffset:     { width: 0, height: 1 },
    shadowOpacity:    0.05,
    shadowRadius:     4,
    elevation:        1,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           Spacing.md,
    padding:       Spacing.lg,
  },
  sectionIconWrap: {
    width:           36,
    height:          36,
    borderRadius:    10,
    backgroundColor: Colors.light.primary + "12",
    alignItems:      "center",
    justifyContent:  "center",
    flexShrink:      0,
  },
  sectionHeaderText: { flex: 1 },
  sectionTitle:    { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: Colors.light.text },
  sectionSubtitle: { fontFamily: Fonts.body, fontSize: 12, color: Bold.quiet, marginTop: 1 },
  sectionBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.light.borderLight,
  },

  // Connections body
  connectionsBody: { padding: Spacing.lg, gap: Spacing.sm },
  subSectionLabel: {
    fontFamily:    Fonts.bodySemiBold,
    fontSize:      11,
    color:         Bold.quiet,
    letterSpacing: 0.8,
    marginBottom:  Spacing.sm,
  },

  // Inbox section header (label + Add picker)
  inboxHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   Spacing.xs,
  },

  // Inbox list container
  inboxList:         { gap: 0 },
  inboxListBordered: {
    borderRadius:  BorderRadius.xs,
    borderWidth:   1,
    borderColor:   Colors.light.border,
    overflow:      "hidden",
    backgroundColor: Colors.light.card,
  },
  inboxListItem:       { paddingHorizontal: Spacing.md, paddingVertical: 10 },
  inboxListItemBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.light.borderLight,
  },
  inboxEmptyText: {
    fontFamily: Fonts.body,
    fontSize:   13,
    color:      "#AAAAAA",
    paddingVertical: Spacing.md,
  },

  // Inbox account row (two-line: alias on top, email below)
  inboxRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           Spacing.sm,
    minHeight:     44,
  },
  inboxRowIcon: { flexShrink: 0, alignSelf: "center" }, // kept for layout reference
  inboxRowTextBlock: {
    flex:    1,
    minWidth: 0,
    gap:     1,
  },
  inboxRowPrimary: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   13,
    color:      Colors.light.text,
  },
  inboxRowSecondary: {
    fontFamily: Fonts.body,
    fontSize:   11,
    color:      Bold.quiet,
  },

  // Add inbox picker
  addBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      BorderRadius.full,
    borderWidth:       1,
    borderColor:       Colors.light.primary + "40",
  },
  addBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   12,
    color:      Colors.light.primary,
  },
  addPickerOpen: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           Spacing.sm,
  },
  addPickerChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               5,
    paddingHorizontal: 10,
    paddingVertical:   5,
    borderRadius:      BorderRadius.full,
    borderWidth:       1,
    borderColor:       Colors.light.border,
    backgroundColor:   Colors.light.backgroundDefault,
  },
  addPickerChipText: {
    fontFamily: Fonts.bodyMedium,
    fontSize:   12,
    color:      Colors.light.textSecondary,
  },

  // Email confirmation row (fresh Gmail add)
  emailConfirmRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           Spacing.sm,
    flex:          1,
  },
  emailConfirmInput: {
    flex:              1,
    height:            34,
    borderWidth:       1,
    borderColor:       Colors.light.border,
    borderRadius:      BorderRadius.xs,
    paddingHorizontal: Spacing.md,
    fontFamily:        Fonts.body,
    fontSize:          13,
    color:             Colors.light.text,
    backgroundColor:   Colors.light.backgroundDefault,
    minWidth:          0,
  },
  emailConfirmBtn: {
    backgroundColor:   Colors.light.primary,
    borderRadius:      BorderRadius.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical:   7,
    alignItems:        "center",
    flexShrink:        0,
  },
  emailConfirmBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   12,
    color:      Colors.light.buttonText,
  },

  // Status badges
  activeBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   Bold.ground,
    paddingHorizontal: 7,
    paddingVertical:   3,
    borderRadius:      BorderRadius.full,
    flexShrink:        0,
  },
  activeBadgeText: {
    fontFamily:    Fonts.bodySemiBold,
    fontSize:      10,
    color:         Bold.ink,
    letterSpacing: 0.3,
  },
  expiredBadge: {
    backgroundColor:   Colors.light.warning + "1F",
    paddingHorizontal: 7,
    paddingVertical:   3,
    borderRadius:      BorderRadius.full,
    flexShrink:        0,
  },
  expiredBadgeText: {
    fontFamily:    Fonts.bodySemiBold,
    fontSize:      10,
    color:         "#B4790F",
    letterSpacing: 0.3,
  },
  pendingBadge: {
    backgroundColor:   Colors.light.textMuted + "1F",
    paddingHorizontal: 7,
    paddingVertical:   3,
    borderRadius:      BorderRadius.full,
    flexShrink:        0,
  },
  pendingBadgeText: {
    fontFamily:    Fonts.bodySemiBold,
    fontSize:      10,
    color:         Colors.light.textMuted,
    letterSpacing: 0.3,
  },
  reconnectBtn: {
    backgroundColor:   Colors.light.primaryLight,
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      BorderRadius.full,
    flexShrink:        0,
  },
  reconnectBtnText: {
    fontFamily: Fonts.bodyBold,
    fontSize:   12,
    fontWeight: "700",
    color:      Colors.light.primary,
  },
  revokedBadge: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   Colors.light.warning + "15",
    paddingHorizontal: 7,
    paddingVertical:   3,
    borderRadius:      BorderRadius.full,
    flexShrink:        0,
  },
  revokedBadgeText: {
    fontFamily:    Fonts.bodySemiBold,
    fontSize:      10,
    color:         Colors.light.warning,
    letterSpacing: 0.3,
  },

  // Reconnect inline (for revoked rows — replaces ···)
  reconnectInline: {
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      BorderRadius.full,
    borderWidth:       1,
    borderColor:       Colors.light.primary + "50",
    flexShrink:        0,
  },
  reconnectInlineText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   11,
    color:      Colors.light.primary,
  },

  // Alias preset picker
  aliasPicker:      { paddingLeft: 28, paddingTop: Spacing.xs, gap: Spacing.xs },
  aliasPickerLabel: { fontFamily: Fonts.bodyMedium, fontSize: 11, color: Bold.quiet },
  aliasPresets:     { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  aliasPresetChip: {
    borderWidth:       1,
    borderColor:       Colors.light.border,
    borderRadius:      BorderRadius.full,
    paddingHorizontal: 10,
    paddingVertical:   4,
    backgroundColor:   Colors.light.backgroundDefault,
  },
  aliasPresetText: {
    fontFamily: Fonts.bodyMedium,
    fontSize:   12,
    color:      Colors.light.textSecondary,
  },

  // Inline alias edit
  aliasEditRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           Spacing.sm,
    paddingLeft:   28,
    paddingTop:    Spacing.xs,
  },
  aliasEditInput: {
    flex:              1,
    height:            36,
    borderWidth:       1,
    borderColor:       Colors.light.border,
    borderRadius:      BorderRadius.xs,
    paddingHorizontal: Spacing.md,
    fontFamily:        Fonts.body,
    fontSize:          13,
    color:             Colors.light.text,
    backgroundColor:   Colors.light.backgroundDefault,
  },
  aliasSaveBtn: {
    backgroundColor:   Colors.light.primary,
    borderRadius:      BorderRadius.xs,
    paddingHorizontal: Spacing.lg,
    paddingVertical:   8,
    minWidth:          56,
    alignItems:        "center",
  },
  aliasSaveBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   13,
    color:      Colors.light.buttonText,
  },

  // Inline actions panel
  actionsPanel: {
    borderTopWidth:  StyleSheet.hairlineWidth,
    borderTopColor:  Colors.light.borderLight,
    paddingTop:      Spacing.sm,
    marginTop:       Spacing.xs,
    gap:             2,
  },
  actionRow: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             Spacing.sm,
    paddingVertical: Spacing.sm,
    paddingLeft:     2,
  },
  actionRowText: {
    fontFamily: Fonts.bodyMedium,
    fontSize:   13,
    color:      Colors.light.textSecondary,
  },
  actionDivider: {
    height:          StyleSheet.hairlineWidth,
    backgroundColor: Colors.light.borderLight,
    marginVertical:  2,
  },

  // Confirm row (disconnect / sign out)
  confirmRow: { gap: Spacing.sm },
  confirmText: {
    fontFamily: Fonts.bodyMedium,
    fontSize:   13,
    color:      Colors.light.text,
  },
  confirmBtns: { flexDirection: "row", gap: Spacing.sm },
  confirmCancel: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: Spacing.sm,
    borderRadius:    BorderRadius.xs,
    borderWidth:     1,
    borderColor:     Colors.light.border,
    backgroundColor: Colors.light.backgroundDefault,
  },
  confirmCancelText: {
    fontFamily: Fonts.bodyMedium,
    fontSize:   13,
    color:      Colors.light.textSecondary,
  },
  confirmRemove: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: Spacing.sm,
    borderRadius:    BorderRadius.xs,
    backgroundColor: Colors.light.error,
  },
  confirmRemoveText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   13,
    color:      "#FFFFFF",
  },

  // Social icon wrapper (replaces char bubble)
  socialIconWrap: {
    width:          36,
    height:         36,
    borderRadius:   10,
    alignItems:     "center",
    justifyContent: "center",
    flexShrink:     0,
  },

  // Social section
  socialSection: {
    borderRadius:  BorderRadius.xs,
    borderWidth:   1,
    borderColor:   Colors.light.border,
    overflow:      "hidden",
  },
  socialRow: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               Spacing.md,
    paddingVertical:   Spacing.md,
    paddingHorizontal: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.borderLight,
    backgroundColor:   Colors.light.card,
  },
  accountChar: {
    width:          34,
    height:         34,
    borderRadius:   9,
    alignItems:     "center",
    justifyContent: "center",
    flexShrink:     0,
  },
  accountCharText: { fontFamily: Fonts.heading, fontSize: 14 },
  socialRowMid:    { flex: 1, minWidth: 0 },
  socialRowLabel:  { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Colors.light.text },
  socialRowHandle: { fontFamily: Fonts.body, fontSize: 12, color: Bold.quiet, marginTop: 1 },
  socialRowRight:  { flexDirection: "row", alignItems: "center", gap: Spacing.sm },

  connectBtn: {
    backgroundColor:   Colors.light.primary,
    borderRadius:      BorderRadius.full,
    paddingHorizontal: Spacing.lg,
    paddingVertical:   6,
    minWidth:          72,
    alignItems:        "center",
  },
  connectBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize:   12,
    color:      Colors.light.buttonText,
  },

  // Account section
  accountBody: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.border },
  accountRow:      { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.border },
  accountRowFirst: { borderTopWidth: 0 },
  accountTile:     { width: 34, height: 34, borderRadius: 10, backgroundColor: Colors.light.backgroundDefault, alignItems: "center", justifyContent: "center" },
  accountRowText:  { flex: 1 },
  accountRowTitle: { fontFamily: Fonts.bodyBold, fontSize: 15 },
  accountRowSub:   { fontFamily: Fonts.body, fontSize: 13, color: Colors.light.textMuted, marginTop: 1 },
  signOutBtn: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             Spacing.sm,
    paddingVertical: Spacing.md,
  },
  signOutText: {
    fontFamily: Fonts.bodyMedium,
    fontSize:   14,
    color:      Colors.light.error,
  },

  // Deal preferences form
  dealPrefsBody:  { padding: Spacing.lg, gap: Spacing.sm },
  dealPrefsHint:  { fontFamily: Fonts.body, fontSize: 12, color: Bold.quiet, marginBottom: Spacing.xs, lineHeight: 17 },
  dealPrefsLabel: { fontFamily: Fonts.bodyMedium, fontSize: 11, color: Bold.quiet, textTransform: "uppercase", letterSpacing: 0.4 },
  dealPrefsInput: {
    height:            40,
    borderWidth:       1,
    borderColor:       Colors.light.border,
    borderRadius:      BorderRadius.xs,
    paddingHorizontal: Spacing.md,
    fontFamily:        Fonts.body,
    fontSize:          14,
    color:             Colors.light.text,
    backgroundColor:   Colors.light.backgroundDefault,
  },
  dealPrefsBtn: {
    marginTop:       Spacing.xs,
    borderRadius:    BorderRadius.xs,
    paddingVertical: 10,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             6,
  },
  dealPrefsBtnActive:    { backgroundColor: Colors.light.primary },
  dealPrefsBtnSaved:     { backgroundColor: "#2E8B57" },
  dealPrefsBtnMuted:     { backgroundColor: "#EFEBE4", borderWidth: 1, borderColor: Colors.light.border },
  dealPrefsBtnText:      { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Colors.light.buttonText },
  dealPrefsBtnTextMuted: { color: Colors.light.text },

  bottomPad: { height: Spacing["4xl"] },
});

// The door / switch rows (Classic layout, Your floor, Notifications) share components/settings/settingsRow.
