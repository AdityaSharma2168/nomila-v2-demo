/**
 * thread/copy.ts — every athlete-facing word the chat v2 module adds. Most are the old chat's own words, reused; the new
 * ones (Copy, Copied, Retry and their spoken labels) are listed in the PR body under "Prompt Register / copy".
 */
export const THREAD_COPY = {
  // Reused from the old chat (MilaSearchOverlay / use-mila-chat), unchanged.
  thinking: "Thinking…",
  placeholder: "Ask Mila anything",
  placeholderWithAttachment: "Say something about it, or just send",
  contractAdded: "I just added a contract. What should I know about it?",
  contractAddedAsked: "I just added the contract you asked me for. What should I know about it?",
  searchPrefill: "Search the web for ",
  send: "Send",
  stop: "Stop",
  newChat: "New chat",
  newChatHint: "Starts a fresh conversation and clears the screen",
  // The server's own sentence for a turn that failed (chatV2Stream STREAM_ERROR_TEXT).
  error: "Mila is unavailable right now — try again in a moment.",
  // Shown while the app catches up with a run after a dropped signal (approved design, section 5).
  stillWorking: "Mila is still working…",
  // New (owner, 2 Nov 2026): the run is still going when the catch-up's wait (the server's turn timeout) has run out.
  slow: "This is taking longer than usual. I'll let you know when it's ready.",
  // New in this module.
  copy: "Copy",
  copyLabel: "Copy Mila's message",
  copied: "Copied",
  retry: "Retry",
  retryLabel: "Retry: send your last message again",
  composerLabel: "Message Mila",
} as const;
