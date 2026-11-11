/**
 * thread/attachments.ts — chat v2's composer attachments: assistant-ui's attachment API with OUR adapter, which puts a
 * picked photo or video into the athlete's media library through the existing upload (use-media-library: mint → PUT →
 * register, the same call today's chat makes), exactly as today's ＋ does:
 *
 *   pick (the ＋ sheet, camera roll) → aui.composer.addAttachment(pickedFile(asset, role))
 *     → adapter.add:  a chip shows "uploading" while the upload runs, then waits for the send ("requires-action")
 *     → adapter.send: the attachment becomes ONE `data-mila-attachment` part on her message ({ assetId, role, thumbUrl })
 *   → the transport sends only the ids and roles (wire.ts chatV2Body); the server checks each is hers.
 *
 * React Native has no File, so the picker's asset rides in a File-shaped object (`pickedFile`): assistant-ui reads only
 * its name and type and hands it back to this adapter. The one-time rights acknowledgment (RightsAckRequired) is not an
 * upload failure: the adapter tells the screen (onRightsAck), which shows today's RightsAckPanel and adds the picks again
 * once she confirms.
 */
import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react-native";
import type * as ImagePicker from "expo-image-picker";
import { RightsAckRequired, type MediaItem, type UploadRole } from "../../../hooks/use-media-library";
import type { MilaAttachmentData } from "./wire";

/** Most attachments on one turn — the server refuses more (server/mila/attachments.ts MAX_ATTACHMENTS). */
export const MAX_ATTACHMENTS = 4;
/** What the composer takes: photos and videos (a contract goes through its own sheet; anything else is refused). */
export const ATTACHMENT_ACCEPT = "image/*,video/*";
/** The status message of an attachment that is waiting for the rights acknowledgment (the screen removes it). */
export const RIGHTS_ACK_MESSAGE = "rights_ack_required";

/** A picked camera-roll asset in the shape assistant-ui's addAttachment takes (it reads `name` and `type`). */
export interface PickedFile {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  asset: ImagePicker.ImagePickerAsset;
  /** "product": tagged for Studio in the library (the ＋ sheet's Product tile). */
  role: "photo" | "product";
  ackRights?: boolean;
}

export function pickedFile(asset: ImagePicker.ImagePickerAsset, role: "photo" | "product", ackRights?: boolean): PickedFile {
  const video = asset.type === "video";
  return {
    name: asset.fileName ?? (video ? "video" : "photo"),
    type: asset.mimeType ?? (video ? "video/mp4" : "image/jpeg"),
    size: asset.fileSize ?? 0,
    // Present so assistant-ui reads this as a file to hand to the adapter, not as a finished attachment.
    lastModified: Date.now(),
    asset,
    role,
    ...(ackRights ? { ackRights: true } : {}),
  };
}

/** The picked file of an attachment in the composer (its local picture for the chip), when it is one of ours. */
export function pickedOf(attachment: { file?: unknown }): PickedFile | null {
  const f = attachment.file as PickedFile | undefined;
  return f && typeof f === "object" && "asset" in f ? f : null;
}

/** The role the server takes for an uploaded asset: a product shot, else the library's own media type. */
export function attachmentRole(picked: PickedFile, item: MediaItem): MilaAttachmentData["role"] {
  if (picked.role === "product") return "product";
  return item.media_type === "VIDEO" || picked.asset.type === "video" ? "video" : "photo";
}

export interface MilaAttachmentDeps {
  /** The existing upload (useUploadMedia().mutateAsync in the app). */
  upload: (input: { asset: ImagePicker.ImagePickerAsset; ackRights?: boolean; role?: UploadRole }) => Promise<MediaItem>;
  /** The library wants the one-time rights acknowledgment before this upload. */
  onRightsAck?: (picked: PickedFile, attachmentId: string) => void;
}

let seq = 0;
const nextId = () => `mila-att-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export function createMilaAttachmentAdapter(deps: MilaAttachmentDeps): AttachmentAdapter {
  // The uploaded asset of each attachment, by attachment id, until it is sent or removed.
  const uploaded = new Map<string, MilaAttachmentData>();
  return {
    accept: ATTACHMENT_ACCEPT,
    async *add({ file }) {
      const picked = file as unknown as PickedFile;
      const id = nextId();
      const base = {
        id,
        type: picked.asset?.type === "video" ? "file" : "image",
        name: picked.name,
        contentType: picked.type,
        file,
      } as const;
      yield { ...base, status: { type: "running", reason: "uploading", progress: 0 } } satisfies PendingAttachment;
      try {
        const item = await deps.upload({ asset: picked.asset, ackRights: picked.ackRights, role: picked.role === "product" ? "product" : undefined });
        uploaded.set(id, { assetId: item.asset_id, role: attachmentRole(picked, item), thumbUrl: item.thumb_url ?? item.url ?? picked.asset.uri ?? null });
        yield { ...base, status: { type: "requires-action", reason: "composer-send" } } satisfies PendingAttachment;
      } catch (e) {
        const ack = e instanceof RightsAckRequired;
        yield { ...base, status: { type: "incomplete", reason: "error", message: ack ? RIGHTS_ACK_MESSAGE : "Upload failed" } } satisfies PendingAttachment;
        if (ack) deps.onRightsAck?.(picked, id);
      }
    },
    async send(attachment): Promise<CompleteAttachment> {
      const data = uploaded.get(attachment.id);
      uploaded.delete(attachment.id);
      // A chip whose upload failed goes with nothing (today's chat sends only the ready ones).
      return { ...attachment, status: { type: "complete" }, content: data ? [{ type: "data", name: "mila-attachment", data }] : [] };
    },
    async remove(attachment) {
      uploaded.delete(attachment.id);
    },
  };
}
