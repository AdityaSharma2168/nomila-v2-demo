// A post action's first picture for Home v3 (the big card, a This week story, the circle): the kit's first asset of her
// own that is still there, else its rendered preview's cover. Reads the same cache as the kit screen (usePostKit), so
// opening "Review & post" draws at once. Null with no action id, while it loads, or when post kits are dark.

import { usePostKit } from "../../lib/agent/hooks";
import type { PostKitResponse } from "../../../shared/postKit";

export function kitPhotoOf(kit: PostKitResponse | null | undefined): string | null {
  if (!kit) return null;
  const own = kit.media.find((m) => m.inKit && m.available && m.thumbUrl);
  return own?.thumbUrl ?? kit.preview?.coverUrl ?? null;
}

export function useKitPhoto(actionId: string | null): string | null {
  const q = usePostKit(actionId, { enabled: !!actionId });
  return kitPhotoOf(q.data);
}
