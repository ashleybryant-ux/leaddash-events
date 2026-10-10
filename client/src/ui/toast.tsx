import { useEffect, useState } from "react";

type Toast = { id: number; text: string; bad?: boolean };
let listeners: ((t: Toast[]) => void)[] = [];
let toasts: Toast[] = [];
let next = 1;

function emit() {
  listeners.forEach((l) => l([...toasts]));
}

/** Shows a short message at the bottom of the screen. */
export function toast(text: string, bad = false) {
  const t = { id: next++, text, bad };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, 3200);
}

/** Error helper for mutations: toast(errorText(err), true). */
export const errorText = (err: unknown) => (err as { message?: string })?.message || "Something went wrong. Please try again.";

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    listeners.push(setItems);
    return () => {
      listeners = listeners.filter((l) => l !== setItems);
    };
  }, []);
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast${t.bad ? " toast-bad" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
