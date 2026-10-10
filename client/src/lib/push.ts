/**
 * Push notices. On iPhone they work only after the app is added to the Home
 * Screen (iOS 16.4 and later); on Android and desktop browsers they work in the browser.
 */
export type PushState = "unsupported" | "needs-install" | "default" | "granted" | "denied";

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function pushState(): PushState {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS() && !isStandalone() ? "needs-install" : "unsupported";
  }
  return Notification.permission as PushState;
}

function urlB64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Asks for permission and returns the subscription to save on the server, or null. */
export async function subscribePush(publicKey: string) {
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  return { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth };
}
