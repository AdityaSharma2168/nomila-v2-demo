// A composed Me tile (client/lib/meTilesLogic.ts): a frame picture with her content laid onto its surfaces, shown as
// ONE flat image. The layers are drawn once, then flattened, and only the flat picture stays on screen:
//
//   native   the layers draw in a hidden-in-plain-sight view; once every picture has loaded, react-native-view-shot
//            snapshots it to a file and the tile becomes a single <Image> of that file (cached by content, so the next
//            visit shows the flat picture straight away)
//   web      the layers draw onto a <canvas> (the same affine maps), which becomes a blob URL behind a single <img>;
//            until then the tile shows its plain frame. A photo the browser will not let a canvas read (no CORS on its
//            host) falls back to the live layers, so the tile still shows her content.
//
// No layer survives in the view tree or the DOM once the flat picture is ready.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import { captureRef } from "react-native-view-shot";
import { Asset } from "expo-asset";
import { outfitFamily } from "../../constants/theme";
import { FRAME_UNITS, type Affine, type ComposedTile as Tile, type Layer, type Surface } from "../../lib/meTilesLogic";

const flat = new Map<string, string>();

interface Props { tile: Tile | null; frame: ImageSourcePropType; size: number; label: string; testID?: string }

export function ComposedTile({ tile, frame, size, label, testID }: Props) {
  const cacheKey = tile ? `${size}|${tile.contentKey}` : null;
  const [uri, setUri] = useState<string | null>(cacheKey ? flat.get(cacheKey) ?? null : null);
  const [live, setLive] = useState(false);

  useEffect(() => { setUri(cacheKey ? flat.get(cacheKey) ?? null : null); setLive(false); }, [cacheKey]);

  // Web: draw on a canvas; the live layers only when the canvas cannot be read back.
  useEffect(() => {
    if (Platform.OS !== "web" || !tile || !cacheKey || flat.has(cacheKey)) return;
    let gone = false;
    drawToBlobUrl(tile, frame, size)
      .then((u) => { if (!gone) { flat.set(cacheKey, u); setUri(u); } })
      .catch(() => { if (!gone) setLive(true); });
    return () => { gone = true; };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = { width: size, height: size };
  if (uri) return <Image source={{ uri }} style={box} accessibilityLabel={label} testID={testID} />;
  if (!tile || (Platform.OS === "web" && !live)) return <Image source={frame} style={box} accessibilityLabel={label} testID={testID} />;
  return (
    <LiveLayers
      tile={tile}
      frame={frame}
      size={size}
      label={label}
      testID={testID}
      onFlat={Platform.OS === "web" ? undefined : (u) => { flat.set(cacheKey!, u); setUri(u); }}
    />
  );
}

/** The layers as views. On native, snapshots itself once every picture has loaded. */
function LiveLayers({ tile, frame, size, label, testID, onFlat }: Omit<Props, "tile"> & { tile: Tile; onFlat?: (uri: string) => void }) {
  const ref = useRef<View>(null);
  const k = size / FRAME_UNITS;
  const pictures = 1 + tile.layers.filter((l) => l.kind === "photo").length;
  const loaded = useRef(0);
  const done = useRef(false);
  const onLoad = () => {
    loaded.current += 1;
    if (!onFlat || done.current || loaded.current < pictures) return;
    done.current = true;
    // One frame later, so the last picture has painted before the snapshot.
    requestAnimationFrame(() => {
      captureRef(ref, { format: "jpg", quality: 0.92, result: "tmpfile" }).then(onFlat).catch(() => undefined);
    });
  };
  const byId = useMemo(() => new Map(tile.surfaces.map((s) => [s.id, s])), [tile]);
  return (
    <View ref={ref} collapsable={false} style={{ width: size, height: size, overflow: "hidden" }} accessibilityLabel={label} testID={testID}>
      <Image source={frame} style={StyleSheet.absoluteFill} onLoad={onLoad} onError={onLoad} />
      {tile.layers.map((l, i) => (
        <SurfaceView key={i} surface={byId.get(l.surface)!} k={k}>
          <LayerView layer={l} k={k} onLoad={onLoad} />
        </SurfaceView>
      ))}
    </View>
  );
}

/** A surface's local box, scaled to the tile and mapped onto its face (RN transforms about the view's centre). */
function SurfaceView({ surface, k, children }: { surface: Surface; k: number; children: React.ReactNode }) {
  const W = surface.w * k;
  const H = surface.h * k;
  const { a, b, c, d } = surface.m;
  const tx = surface.m.e * k - W / 2 + (a * W) / 2 + (c * H) / 2;
  const ty = surface.m.f * k - H / 2 + (b * W) / 2 + (d * H) / 2;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transform: [{ matrix: [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1] }] }}>
      {children}
    </View>
  );
}

function LayerView({ layer, k, onLoad }: { layer: Layer; k: number; onLoad: () => void }) {
  const [x, y, w, h] = layer.box.map((v) => v * k);
  const pos = { position: "absolute" as const, left: x, top: y, width: w, height: h };
  if (layer.kind === "rect") return <View style={[pos, { backgroundColor: layer.fill }]} />;
  if (layer.kind === "photo") return <Image source={{ uri: layer.uri }} style={pos} resizeMode="cover" onLoad={onLoad} onError={onLoad} />;
  return (
    <View style={[pos, { justifyContent: "center" }]}>
      <Text
        numberOfLines={1}
        style={{ fontFamily: outfitFamily(layer.weight), fontSize: layer.size * k, lineHeight: layer.size * k * 1.2, color: layer.color, textAlign: layer.align, letterSpacing: (layer.tracking ?? 0) * k }}
      >
        {layer.text}
      </Text>
    </View>
  );
}

// ── Web: the same composition on a canvas ────────────────────────────────────────────────────────────────────────────

function loadImage(src: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new (globalThis as any).Image() as HTMLImageElement;
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function frameUri(frame: ImageSourcePropType): string {
  if (typeof frame === "object" && frame && "uri" in (frame as any)) return (frame as any).uri;
  return Asset.fromModule(frame as number).uri;
}

async function drawToBlobUrl(tile: Tile, frame: ImageSourcePropType, size: number): Promise<string> {
  const doc = (globalThis as any).document as Document;
  const ratio = Math.min(3, (globalThis as any).devicePixelRatio || 2);
  const px = Math.round(size * ratio);
  const canvas = doc.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  const photos = new Map<string, HTMLImageElement>();
  const [base] = await Promise.all([
    loadImage(frameUri(frame), false),
    ...tile.layers.filter((l): l is Extract<Layer, { kind: "photo" }> => l.kind === "photo")
      .map(async (l) => { if (!photos.has(l.uri)) photos.set(l.uri, await loadImage(l.uri, true)); }),
    (doc as any).fonts?.ready,
  ]);
  const unit = px / FRAME_UNITS;
  ctx.drawImage(base, 0, 0, px, px);
  const byId = new Map(tile.surfaces.map((s) => [s.id, s]));
  for (const l of tile.layers) {
    const m: Affine = byId.get(l.surface)!.m;
    ctx.save();
    ctx.setTransform(unit, 0, 0, unit, 0, 0);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    const [x, y, w, h] = l.box;
    if (l.kind === "rect") { ctx.fillStyle = l.fill; ctx.fillRect(x, y, w, h); }
    if (l.kind === "photo") {
      const img = photos.get(l.uri)!;
      const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      const sw = w / scale;
      const sh = h / scale;
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
    }
    if (l.kind === "text") {
      ctx.font = `${l.weight} ${l.size}px ${outfitFamily(l.weight)}, Outfit, system-ui, sans-serif`;
      if ("letterSpacing" in ctx) (ctx as any).letterSpacing = `${l.tracking ?? 0}px`;
      ctx.fillStyle = l.color;
      ctx.textBaseline = "middle";
      ctx.textAlign = l.align;
      ctx.fillText(l.text, l.align === "left" ? x : l.align === "right" ? x + w : x + w / 2, y + h / 2, w);
    }
    ctx.restore();
  }
  // Throws on a tainted canvas (a photo host without CORS): the caller falls back to the live layers.
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", 0.92));
  return URL.createObjectURL(blob);
}
