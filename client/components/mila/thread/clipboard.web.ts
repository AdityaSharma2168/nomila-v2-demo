/**
 * thread/clipboard (web): navigator.clipboard where the page may use it (a secure context, a user gesture); otherwise
 * the old select-and-copy through a hidden textarea, which still works in an embedded or insecure page.
 */
export async function copyText(text: string): Promise<boolean> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (permissions, an insecure context): fall through to the textarea.
  }
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.body) return false;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}
