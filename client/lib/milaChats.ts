// Delete Mila chats: one conversation, or all of them (decision 9 — the athlete
// controls her chat history). The server scopes both by the signed-in athlete;
// the conversation id here only picks which of HER chats to remove.

import { fetch } from "expo/fetch";
import { Alert } from "react-native";
import { getApiUrl, getAuthHeaders } from "./query-client";

async function del(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${getApiUrl()}${path}`, {
      method: "DELETE",
      headers: { ...(await getAuthHeaders()) },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function deleteChat(conversationId: string): Promise<boolean> {
  return del(`/api/v1/me/conversations/${encodeURIComponent(conversationId)}`);
}

export function deleteAllChats(): Promise<boolean> {
  return del("/api/v1/me/conversations");
}

/**
 * Confirm, then delete. Resolves true only when the server deleted it; a failure
 * tells her plainly and leaves the chat where it was.
 */
export function confirmDeleteChat(conversationId: string): Promise<boolean> {
  return confirmThen(
    "Delete this chat?",
    "Mila will forget this conversation. This can't be undone.",
    () => deleteChat(conversationId),
  );
}

export function confirmDeleteAllChats(): Promise<boolean> {
  return confirmThen(
    "Delete all chats?",
    "Every conversation with Mila will be deleted. This can't be undone.",
    deleteAllChats,
  );
}

function confirmThen(title: string, message: string, run: () => Promise<boolean>): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const ok = await run();
          if (!ok) Alert.alert("Couldn't delete", "Please try again in a moment.");
          resolve(ok);
        },
      },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}
