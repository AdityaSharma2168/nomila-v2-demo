/** thread/clipboard (iOS / Android): expo-clipboard. Web: clipboard.web.ts. Resolves true once the text is copied. */
import * as Clipboard from "expo-clipboard";

export async function copyText(text: string): Promise<boolean> {
  try {
    return await Clipboard.setStringAsync(text);
  } catch {
    return false;
  }
}
