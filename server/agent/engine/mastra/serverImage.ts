/**
 * agent/engine/mastra/serverImage.ts — the one kind of image a Mila turn may carry: one THIS server made from the
 * athlete's own library (attachments.ts). Minted here and registered in a module-private WeakSet, so the turn's guard
 * (guards.ts turnImageContext) can tell a server-made image from anything else: a client's URL, data URI or bytes, or a
 * look-alike object, are never in the set. Kept apart from attachments.ts so the guards load no storage or sharp.
 */

/** Images per turn, photos and video frames together. */
export const MAX_TURN_IMAGES = 8;

/** One image for the model: inline JPEG bytes (base64), never a URL, and a short label naming the attachment. */
export interface ServerImage { readonly data: string; readonly mediaType: "image/jpeg"; readonly label: string }

const minted = new WeakSet<object>();

/** attachments.ts only: an image made here, from bytes read from her library and re-encoded by sharp. */
export function mintServerImage(jpeg: Buffer, label: string): ServerImage {
  const img = Object.freeze({ data: jpeg.toString("base64"), mediaType: "image/jpeg" as const, label });
  minted.add(img);
  return img;
}

export function isServerImage(x: unknown): x is ServerImage {
  return typeof x === "object" && x !== null && minted.has(x);
}
