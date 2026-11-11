import { useQuery } from "@tanstack/react-query";

export interface Connection {
  id:                string;
  platform:          string;
  alias:             string | null;
  status:            string;
  platform_username: string | null;
  last_fetched_at:   string | null;
  created_at:        string;
  can_send:          boolean;
  /** Gmail only: the grant includes gmail.compose, so "save draft" can mirror to Gmail.
   *  A send-only grant cannot create drafts — see server/routes/connections.ts. */
  can_draft:         boolean;
}

interface ConnectionsResponse {
  connections: Connection[];
}

export function useConnections() {
  const query = useQuery<ConnectionsResponse>({
    queryKey: ["/api/v1/me/connections"],
  });

  const connections = query.data?.connections ?? [];

  // All connections for a platform — for Settings display (includes revoked/pending)
  function forPlatform(platform: string): Connection[] {
    return connections.filter((c) => c.platform === platform);
  }

  // Only healthy connections — for "is this platform syncing?" checks (badges, etc.)
  function activeForPlatform(platform: string): Connection[] {
    return connections.filter((c) => c.platform === platform && c.status === "active");
  }

  // True if at least one active connection exists for the platform
  function isConnected(platform: string): boolean {
    return activeForPlatform(platform).length > 0;
  }

  // True if any connection for the platform needs attention (expired/revoked/pending — not syncing)
  function hasIssue(platform: string): boolean {
    return connections.some(
      (c) => c.platform === platform && (c.status === "expired" || c.status === "revoked" || c.status === "pending"),
    );
  }

  // True if at least one active connection for the platform can send (not just read).
  // Gmail needs a send-capable OAuth scope; a read-only grant returns false until reconnect.
  function canSend(platform: string): boolean {
    return activeForPlatform(platform).some((c) => c.can_send);
  }

  // True if a saved draft can be mirrored into the athlete's real Gmail Drafts folder.
  // Distinct from canSend: gmail.send authorises sending but NOT drafts.create, and every
  // Gmail grant issued before gmail.compose was added is send-only. False here means the
  // app draft still saves — it just won't appear in Gmail until the mailbox is reconnected.
  function canDraft(platform: string): boolean {
    return activeForPlatform(platform).some((c) => c.can_draft);
  }

  return {
    connections,
    forPlatform,
    activeForPlatform,
    isConnected,
    hasIssue,
    canSend,
    canDraft,
    isLoading: query.isLoading,
    refetch:   query.refetch,
  };
}
