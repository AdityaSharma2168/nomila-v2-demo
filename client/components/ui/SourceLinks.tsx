/**
 * SourceLinks — the web pages a search found, each a tappable link (opens in the browser).
 *
 * Why it exists: our web search is OpenAI's, and its terms say that wherever an interface shows web
 * results or information taken from them, the sources are shown as prominent, clickable links. So every
 * surface that shows what a search found (a Studio moment, a brand's researched profile) shows these.
 *
 * The look is the app's existing source link (EntryInfoSheet / EvidenceSheet): an external-link icon and
 * the site's name. `onDark` is the same row in white for the photo decks. On web each one is a real
 * <a href target=_blank rel=noopener> (react-native-web renders a Text with `href` as an anchor), so it can be
 * opened, copied or middle-clicked like any link; on native it opens the browser through Linking.
 */
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";

export interface SourceLinkItem {
  url: string | null | undefined;
  title?: string | null;
  domain?: string | null;
}

/** The site's name for a link: the domain when given, else the URL's host (without www.). */
export function sourceLabel(s: SourceLinkItem): string {
  if (s.domain?.trim()) return s.domain.trim();
  try {
    return new URL(s.url ?? "").hostname.replace(/^www\./, "") || (s.url ?? "");
  } catch {
    return s.title?.trim() || s.url || "source";
  }
}

/** Only real web links, de-duplicated, capped. Pure: what the row will show. */
export function linkableSources(sources: readonly SourceLinkItem[] | null | undefined, max = 3): (SourceLinkItem & { url: string })[] {
  const seen = new Set<string>();
  const out: (SourceLinkItem & { url: string })[] = [];
  for (const s of sources ?? []) {
    const url = typeof s?.url === "string" ? s.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...s, url });
    if (out.length >= max) break;
  }
  return out;
}

export function SourceLinks({
  sources,
  max = 3,
  onDark = false,
  testID,
}: {
  sources: readonly SourceLinkItem[] | null | undefined;
  max?: number;
  onDark?: boolean;
  testID?: string;
}) {
  const links = linkableSources(sources, max);
  if (!links.length) return null;
  const color = onDark ? Bold.onDark : Bold.blue;
  return (
    <View style={styles.row} testID={testID}>
      {links.map((s) => {
        const label = sourceLabel(s);
        if (Platform.OS === "web") {
          const webLink = { href: s.url, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } } as object;
          return (
            <View key={s.url} style={styles.link}>
              <Feather name="external-link" size={12} color={color} />
              <Text {...webLink} accessibilityRole="link" style={[styles.text, { color }]} numberOfLines={1}>
                {label}
              </Text>
            </View>
          );
        }
        return (
          <Pressable
            key={s.url}
            onPress={() => Linking.openURL(s.url)}
            accessibilityRole="link"
            accessibilityLabel={`Open source: ${label}`}
            hitSlop={8}
            style={styles.link}
          >
            <Feather name="external-link" size={12} color={color} />
            <Text style={[styles.text, { color }]} numberOfLines={1}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 6 },
  link: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" },
  text: { ...BoldType.link, textDecorationLine: "underline", flexShrink: 1 },
});
