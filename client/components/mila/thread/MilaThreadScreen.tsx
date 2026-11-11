/**
 * thread/MilaThreadScreen — the Mila chat surface on chat v2 (EXPO_PUBLIC_MILA_THREAD_V2). It takes the old surface's
 * props (MilaSearchOverlay) and is what that export renders when the flag is on, so every launcher (the Mila tab, Home's
 * sheet) is unchanged. The look is the old chat's: her floating avatar and frosted status label (MilaHeader, driven by
 * milaActivity from the stream's status parts), the one frosted menu (saved chats · new chat · delete) and the one
 * new-chat action, the openers, the frosted composer.
 *
 * Presentations: "tab" draws in place (the bottom menu stays under it); "modal" and "sheet" open as a full-screen
 * Modal (the sheet's half-height drag is not on this path yet).
 *
 * Today's chat's other pieces, reused as they are: voice (useMilaVoice: the composer's voice button and the live bar;
 * spoken turns and voice cards show live in this thread and are saved by the voice worker into this conversation), the
 * ＋ (MilaAttachSheet: photo or video and product from the camera roll through assistant-ui's composer attachments and
 * our adapter onto the media upload, a contract through AddContractSheet, a web search as a composer prefill), a
 * request chip's sheets (AddContractSheet / RequestDocumentSheet), the nav chips under an answer, Mila's camera-roll
 * offer, and opening ON a given message (a push).
 *
 * NOT on this path yet (the old chat keeps them): edit-and-resend (the server ignores client history, so a past turn
 * cannot be rewritten from the phone), profile confirms and live follow-up questions (no engine sends them today),
 * the Home sheet's half-height drag, the tab's rise-in entrance.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react-native";
import type * as ImagePicker from "expo-image-picker";
import { MilaHeader, HEADER_AVATAR_LARGE } from "../MilaHeader";
import { Frost } from "../Frost";
import { MilaChatMenu, type MilaChatMenuAction } from "../MilaChatMenu";
import { SavedChatsSheet } from "../SavedChatsSheet";
import { MilaAttachSheet, type MilaAttachKind } from "../MilaAttachSheet";
import { useMilaVoice } from "../useMilaVoice";
import { AddContractSheet } from "../../deals/AddContractSheet";
import { RequestDocumentSheet } from "../../requests/RequestDocumentSheet";
import { RightsAckPanel } from "../../media/RightsAckPanel";
import { pickFromCameraRoll, useUploadMedia } from "../../../hooks/use-media-library";
import { activityFrom, useHeldActivity } from "../milaActivity";
import { AgentCardHandlersProvider, type AgentCardHandlers } from "../../agent/handlers";
import { CardKitHost } from "../cards/kit";
import { N, oppsFont } from "../../deals/opps/tokens";
import { chatTargetFor } from "../../../lib/agent/navigate";
import { connectService } from "../../../lib/agent/connect";
import { confirmDeleteChat } from "../../../lib/milaChats";
import { haptics } from "../../../lib/haptics";
import { emptySubtitleFor, greetingFor, openersFor } from "../../../screens/milaOpeners";
import type { MilaContext, MilaNavTarget } from "../../../hooks/use-mila-chat";
import { MilaThreadView, OpenerRow } from "./MilaThreadView";
import { useMilaThread, type MilaThreadOptions } from "./useMilaThread";
import { THREAD_COPY } from "./copy";
import { createMilaAttachmentAdapter, MAX_ATTACHMENTS, pickedFile, RIGHTS_ACK_MESSAGE } from "./attachments";

const HEADER_ESTIMATE = HEADER_AVATAR_LARGE + 44;
const TOP_BTN = 40;

export interface MilaThreadScreenProps {
  visible: boolean;
  onClose: () => void;
  onNavigate?: (target: MilaNavTarget) => void;
  initialPrompt?: string;
  initialDraft?: string;
  initialContext?: MilaContext;
  variant?: "default" | "onboarding";
  presentation?: "modal" | "tab" | "sheet";
  onOnboardingDone?: (door: "profile" | "deals" | null) => void;
  onInitialPromptSent?: () => void;
  offer?: { label: string; onPress: () => void } | null;
  initialConversationId?: string;
  initialMessageId?: string;
  onInitialConversationOpened?: () => void;
  /** Tests only: the thread's timings and API. */
  threadOptions?: MilaThreadOptions;
}

export function MilaThreadScreen(props: MilaThreadScreenProps) {
  const {
    visible, onClose, onNavigate, initialPrompt, initialDraft, initialContext, presentation = "modal",
    onInitialPromptSent, offer, initialConversationId, initialMessageId, onInitialConversationOpened, threadOptions,
  } = props;
  const insets = useSafeAreaInsets();
  const inTab = presentation === "tab";

  // ── The ＋: today's upload (mint → PUT → register) behind assistant-ui's composer attachments ──────────────────────
  const uploadMedia = useUploadMedia();
  const uploadRef = useRef(threadOptions?.upload ?? uploadMedia.mutateAsync);
  uploadRef.current = threadOptions?.upload ?? uploadMedia.mutateAsync;
  // The one-time rights acknowledgment: the picks wait here, and go up again once she confirms.
  const [ackAssets, setAckAssets] = useState<{ assets: ImagePicker.ImagePickerAsset[]; role: "photo" | "product" } | null>(null);
  const ackRef = useRef<(asset: ImagePicker.ImagePickerAsset, role: "photo" | "product") => void>(() => {});
  ackRef.current = (asset, role) => setAckAssets((prev) => ({ assets: [...(prev?.assets ?? []), asset], role }));
  const attachmentAdapter = useMemo(() => createMilaAttachmentAdapter({
    upload: (input) => uploadRef.current(input),
    onRightsAck: (picked) => ackRef.current(picked.asset, picked.role),
  }), []);

  const thread = useMilaThread(threadOptions, { attachments: attachmentAdapter });

  // ── Voice: today's session, on THIS conversation (the worker saves the spoken turns into it) ──────────────────────
  const useVoice = useRef(threadOptions?.useVoice ?? useMilaVoice).current;
  const voice = useVoice({ conversationId: thread.conversationId, onTranscript: thread.appendTranscript, onWidget: thread.appendWidgetMessage });

  const activity = useHeldActivity(activityFrom(voice.state, thread.phase));
  const [headerH, setHeaderH] = useState(HEADER_ESTIMATE);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  // A request chip's sheet ("prompt me for my contract" / "…performance data"), as in today's chat.
  const [contractRequestId, setContractRequestId] = useState<string | null>(null);
  const [documentRequestId, setDocumentRequestId] = useState<string | null>(null);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const count = thread.messages.length;
  const composerRef = useRef<ComposerBridge | null>(null);

  // A card's taps outside the card: a reply or a workflow goes to Mila as her message; a link opens its screen or page.
  const sendRef = useRef(thread.send);
  sendRef.current = thread.send;
  const prefillRef = useRef<(text: string) => void>(() => {});
  const onLink = useCallback((target: MilaNavTarget) => {
    haptics.press();
    // A request chip opens the EXISTING upload surface here, over the conversation (today's chat): nothing is created
    // until she saves.
    if (target.screen === "add_contract") { setContractRequestId(target.requestId); setContractOpen(true); return; }
    if (target.screen === "add_document") { setDocumentRequestId(target.requestId); return; }
    onClose();
    onNavigate?.(target);
  }, [onClose, onNavigate]);
  const cardHandlers = useMemo<AgentCardHandlers>(() => ({
    startWorkflow: (prompt) => { void sendRef.current(prompt); },
    reply: (text) => { void sendRef.current(text); },
    connect: (connectorId) => connectService(connectorId),
    prefill: (text) => prefillRef.current(text),
    openLink: (target) => {
      const t = chatTargetFor(target);
      if (!t) return;
      if ("url" in t) { void Linking.openURL(t.url).catch(() => {}); return; }
      onLink(t as MilaNavTarget);
    },
  }), [onLink]);

  // On show: catch up with the shared thread (unless a saved chat is named), then a chip's one-shot ask.
  const promptSentRef = useRef(onInitialPromptSent);
  promptSentRef.current = onInitialPromptSent;
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const caughtUp = initialConversationId ? Promise.resolve() : thread.syncToShared();
    if (initialPrompt) {
      void caughtUp.finally(() => {
        if (cancelled) return;
        void thread.send(initialPrompt);
        promptSentRef.current?.();
      });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialPrompt]);

  useEffect(() => {
    if (!visible || !initialConversationId) return;
    // Open ON that message (one Mila started, from its notification) once it is drawn.
    setTargetMessageId(initialMessageId ?? null);
    void thread.openConversation(initialConversationId);
    onInitialConversationOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialConversationId]);

  // ── The ＋ sheet's four ────────────────────────────────────────────────────────────────────────────────────────────
  const addPicked = useCallback(async (assets: ImagePicker.ImagePickerAsset[], role: "photo" | "product", ackRights?: boolean) => {
    for (const asset of assets) {
      const c = composerRef.current;
      if (!c || c.attachmentCount() >= MAX_ATTACHMENTS) return;
      try { await c.addAttachment(pickedFile(asset, role, ackRights)); } catch { /* the chip says it failed */ }
    }
    // Picks that wait for the rights acknowledgment come out of the composer; the panel asks once.
    composerRef.current?.removeWaitingForAck();
  }, []);

  const onAttachPick = useCallback(async (kind: MilaAttachKind) => {
    const c = composerRef.current;
    if (!c) return;
    if (kind === "contract") { setContractOpen(true); return; }
    if (kind === "search") { if (!c.getText().trim()) c.setText(THREAD_COPY.searchPrefill); return; }
    const room = MAX_ATTACHMENTS - c.attachmentCount();
    if (room <= 0) return;
    try {
      const pick = threadOptions?.pick ?? pickFromCameraRoll;
      const picked = await pick(kind === "product" ? "photo" : "all", { multiple: true, selectionLimit: room });
      if (picked?.assets.length) await addPicked(picked.assets.slice(0, room), kind);
    } catch {
      // Permission refused or the picker failed: nothing staged, nothing to undo.
    }
  }, [addPicked, threadOptions?.pick]);

  const onMenuPick = useCallback(async (action: MilaChatMenuAction) => {
    if (action === "history") setHistoryVisible(true);
    else if (action === "new") thread.newChat();
    else if (await confirmDeleteChat(thread.conversationId)) thread.newChat();
  }, [thread]);

  const offerRow = offer ? <OpenerRow label={offer.label} onPress={offer.onPress} /> : null;
  const ackPanel = ackAssets ? (
    <View style={styles.ackWrap}>
      <RightsAckPanel
        busy={uploadMedia.isPending}
        onConfirm={() => { const a = ackAssets; setAckAssets(null); void addPicked(a.assets, a.role, true); }}
        onCancel={() => setAckAssets(null)}
      />
    </View>
  ) : null;

  const openers = openersFor(initialContext);
  const empty = (
    <View style={styles.empty} testID="thread-empty">
      <Text style={styles.emptyTitle}>{greetingFor(initialContext)}</Text>
      <Text style={styles.emptySubtitle}>{emptySubtitleFor()}</Text>
      <View style={styles.suggestList}>
        {offerRow}
        {openers.map((s) => <OpenerRow key={s} label={s} onPress={() => { void thread.send(s); }} />)}
      </View>
    </View>
  );

  const body = (
    <View style={[styles.root, { paddingTop: insets.top }]} testID="mila-chat">
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        <AssistantRuntimeProvider runtime={thread.runtime}>
          <DraftSetter draft={visible ? initialDraft : undefined} prefillRef={prefillRef} composerRef={composerRef} />
          <View style={styles.flex}>
            <MilaThreadView
              thread={thread}
              topInset={headerH}
              bottomInset={inTab ? 0 : insets.bottom}
              empty={empty}
              convoTop={offerRow}
              voice={voice}
              onAttach={() => setAttachOpen(true)}
              composerTop={ackPanel}
              onNav={onLink}
              targetMessageId={targetMessageId}
            />
            {/* After the transcript so it draws over it; the header places itself (absolute, top-centre). Small in a
                typed conversation; back to full size while voice is live (today's chat). */}
            <MilaHeader activity={activity} compact={count > 0 && !voice.active} active={visible} onHeight={setHeaderH} announce={false} />
            <View style={styles.headerControls} pointerEvents="box-none">
              <Pressable
                onPress={() => { haptics.press(); Keyboard.dismiss(); setMenuOpen(true); }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Chat menu"
                accessibilityHint="Saved chats, a new chat, or delete this one"
                style={({ pressed }) => [styles.topBtn, pressed && { opacity: 0.7 }]}
              >
                <Frost radius={TOP_BTN / 2} style={styles.topBtnGlass}>
                  <Feather name="menu" size={17} color={N.ink700} />
                </Frost>
              </Pressable>
              <Pressable
                onPress={() => { haptics.press(); thread.newChat(); }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={THREAD_COPY.newChat}
                accessibilityHint={THREAD_COPY.newChatHint}
                style={({ pressed }) => [styles.topBtn, pressed && { opacity: 0.7 }]}
                testID="thread-new-chat"
              >
                <Frost radius={TOP_BTN / 2} style={styles.topBtnGlass}>
                  <Feather name="edit" size={16} color={N.ink700} />
                </Frost>
              </Pressable>
            </View>
          </View>
        </AssistantRuntimeProvider>
      </KeyboardAvoidingView>
    </View>
  );

  // The card kit (EXPO_PUBLIC_MILA_CARDS_V2): chat behaviour — a body tap expands in place, one open at a time, ≤ 2 faces.
  const drawn = <AgentCardHandlersProvider value={cardHandlers}><CardKitHost surface="chat">{body}</CardKitHost></AgentCardHandlersProvider>;
  return (
    <>
      {inTab ? drawn : (
        <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>{drawn}</Modal>
      )}
      <MilaChatMenu
        visible={menuOpen}
        top={insets.top + 4 + TOP_BTN + 8}
        canDelete={count > 0}
        onClose={() => setMenuOpen(false)}
        onPick={(a) => { void onMenuPick(a); }}
      />
      <SavedChatsSheet
        visible={historyVisible}
        onClose={() => setHistoryVisible(false)}
        onSelect={(id) => { setHistoryVisible(false); void thread.openConversation(id); }}
        onDeleted={(id) => { if (id === "all" || id === thread.conversationId) thread.newChat(); }}
      />

      {/* The ＋ sheet, and the contract sheet it can open: today's, unchanged. A contract lands exactly where one from
          the Deals screen does (upload, read, REVIEW, save), and a non-contract file is refused by the same gate. */}
      <MilaAttachSheet visible={attachOpen} onClose={() => setAttachOpen(false)} onPick={(k) => { void onAttachPick(k); }} />
      <AddContractSheet
        visible={contractOpen}
        requestId={contractRequestId ?? undefined}
        onClose={() => { setContractOpen(false); setContractRequestId(null); }}
        onCreated={() => {
          const answered = contractRequestId != null;
          setContractOpen(false);
          setContractRequestId(null);
          void thread.send(answered ? THREAD_COPY.contractAddedAsked : THREAD_COPY.contractAdded);
        }}
      />
      <RequestDocumentSheet
        visible={documentRequestId != null}
        requestId={documentRequestId}
        onClose={() => setDocumentRequestId(null)}
        onDone={() => { /* the sheet shows its own confirmation; the request is now acquired */ }}
      />
    </>
  );
}

/** What the screen needs of the composer (it lives in the runtime, so a child inside the provider hands it out). */
interface ComposerBridge {
  getText: () => string;
  setText: (text: string) => void;
  attachmentCount: () => number;
  addAttachment: (file: ReturnType<typeof pickedFile>) => Promise<void>;
  /** Takes out the picks waiting for the rights acknowledgment (the panel asks for it once, then adds them again). */
  removeWaitingForAck: () => void;
}

/** The launcher's draft goes into the composer (not sent); a card's "Tell Mila" fills it the same way. */
function DraftSetter({ draft, prefillRef, composerRef }: {
  draft?: string;
  prefillRef: React.MutableRefObject<(text: string) => void>;
  composerRef: React.MutableRefObject<ComposerBridge | null>;
}) {
  // Inside the runtime provider, so it can reach the composer.
  const aui = useAui();
  // Read so the bridge's answers are current (the composer's state lives in the runtime).
  useAuiState((s) => s.composer.attachments.length);
  prefillRef.current = (text: string) => aui.composer.setText(text);
  composerRef.current = {
    getText: () => aui.composer.getState().text,
    setText: (text) => aui.composer.setText(text),
    attachmentCount: () => aui.composer.getState().attachments.length,
    // assistant-ui reads a File's name and type; the picked asset rides along for our adapter (thread/attachments.ts).
    addAttachment: (file) => aui.composer.addAttachment(file as unknown as File),
    removeWaitingForAck: () => {
      for (const a of aui.composer.getState().attachments) {
        if (a.status.type === "incomplete" && "message" in a.status && a.status.message === RIGHTS_ACK_MESSAGE) {
          void aui.composer.attachment({ id: a.id }).remove().catch(() => {});
        }
      }
    },
  };
  useEffect(() => { if (draft) aui.composer.setText(draft); }, [draft, aui]);
  return null;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: N.cream100 },
  headerControls: {
    position: "absolute",
    top: 4,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  topBtn: { width: TOP_BTN, height: TOP_BTN, borderRadius: TOP_BTN / 2 },
  topBtnGlass: { width: TOP_BTN, height: TOP_BTN, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center" },
  emptyTitle: { fontFamily: oppsFont(800), fontSize: 22, color: N.ink900, letterSpacing: -0.4, lineHeight: 26, maxWidth: 270, textAlign: "center" },
  emptySubtitle: { fontFamily: oppsFont(400), fontSize: 14.5, color: N.ink500, lineHeight: 22, marginTop: 8, maxWidth: 290, textAlign: "center" },
  suggestList: { gap: 10, marginTop: 28, width: "100%" },
  ackWrap: { marginBottom: 10 },
});
