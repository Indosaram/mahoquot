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
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const pushToast = useCallback(
    (message: string) => {
      if (!message) return;
      const id = nextId.current + 1;
      nextId.current = id;
      const tone = toastTone(message);
      setToasts((current) => [...current.slice(-(MAX_TOASTS - 1)), { id, message, tone }]);
      timers.current.set(
        id,
        setTimeout(() => dismissToast(id), tone === "error" ? ERROR_TTL_MS : INFO_TTL_MS),
      );
    },
    [dismissToast],
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
