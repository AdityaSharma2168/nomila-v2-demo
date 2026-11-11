/* eslint-disable no-undef */
/**
 * firebase-messaging-sw.js — the dev web build's notification worker (EXPO_PUBLIC_WEB_V2; copied into dist by
 * scripts/inject-web-v2.js, so the production web app never serves it). Registered by client/lib/webPush.ts.
 *
 * The server (server/services/push/push.ts) sends DATA-ONLY messages: { title, body, kind, target (JSON), quiet "1"|"0" }.
 *   - app closed or in the background: this worker shows the notification (quiet hours → silent);
 *   - app open and focused: the page receives it and shows nothing (same as the phone app);
 *   - a tap: focuses an open Nomila window and posts { type: "nomila-push-tap", target } to it, or opens
 *     /?pushTarget=<screen>&pushId=<id> when none is open. client/lib/push.ts turns either into the screen to open.
 *
 * The Firebase web config below is public (the same values as client/lib/firebase-client.ts).
 */
importScripts("https://www.gstatic.com/firebasejs/12.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAfVZNcQ65LcRQPh1XbUZYT4Yab5WFcvGw",
  authDomain: "gamechanger-pocket-agent.firebaseapp.com",
  projectId: "gamechanger-pocket-agent",
  storageBucket: "gamechanger-pocket-agent.firebasestorage.app",
  messagingSenderId: "241621020090",
  appId: "1:241621020090:web:a4c064de2e19791aa88183",
});

const messaging = firebase.messaging();

function parseTarget(raw) {
  try {
    const t = JSON.parse(raw || "null");
    return t && typeof t.screen === "string" ? t : null;
  } catch (e) {
    return null;
  }
}

messaging.onBackgroundMessage((payload) => {
  const d = (payload && payload.data) || {};
  return self.registration.showNotification(d.title || "Nomila", {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: d.kind || "nomila",
    silent: d.quiet === "1",
    data: { target: parseTarget(d.target) },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.target) || null;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: "nomila-push-tap", target });
        return;
      }
    }
    let url = "/";
    if (target) {
      url += "?pushTarget=" + encodeURIComponent(target.screen) + (target.id ? "&pushId=" + encodeURIComponent(target.id) : "");
    }
    await clients.openWindow(url);
  })());
});
