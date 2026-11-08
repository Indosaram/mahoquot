import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "info" | "error";

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
}

const INFO_TTL_MS = 4_500;
const ERROR_TTL_MS = 8_000;
const MAX_TOASTS = 4;

export const toastTone = (message: string): ToastTone =>
  message.startsWith("Action failed") ? "error" : "info";

export const useToasts = () => {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const toastsRef = useRef<readonly Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const clearToastTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: number) => {
      clearToastTimer(id);
      toastsRef.current = toastsRef.current.filter((toast) => toast.id !== id);
      setToasts(toastsRef.current);
    },
    [clearToastTimer],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const pushToast = useCallback(
    (message: string) => {
      if (!message) return;
      const tone = toastTone(message);
      const ttl = tone === "error" ? ERROR_TTL_MS : INFO_TTL_MS;

      // Same message already visible: restart its timer rather than stacking a duplicate.
      const duplicate = toastsRef.current.find((toast) => toast.message === message);
      if (duplicate) {
        clearToastTimer(duplicate.id);
        timers.current.set(
          duplicate.id,
          setTimeout(() => dismissToast(duplicate.id), ttl),
        );
        return;
      }

      nextId.current += 1;
      const id = nextId.current;
      const next = [...toastsRef.current.slice(-(MAX_TOASTS - 1)), { id, message, tone }];
      for (const dropped of toastsRef.current) {
        if (!next.some((toast) => toast.id === dropped.id)) clearToastTimer(dropped.id);
      }
      toastsRef.current = next;
      setToasts(next);
      timers.current.set(
        id,
        setTimeout(() => dismissToast(id), ttl),
      );
    },
    [clearToastTimer, dismissToast],
  );

  return { toasts, pushToast, dismissToast };
};

export const ToastStack = ({
  toasts,
  onDismiss,
}: {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: number) => void;
}) =>
  toasts.length ? (
    <output className="toast-stack">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast-${toast.tone}`}
          onClick={() => onDismiss(toast.id)}
        >
          {toast.message}
        </button>
      ))}
    </output>
  ) : null;
