"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  ReactNode,
  useEffect,
  useId,
} from "react";
import { createPortal } from "react-dom";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration?: number; // ms, 0 = no auto-dismiss
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (toast: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_LIMIT = 5;
const DEFAULT_DURATION = 5000;

const toastStyles: Record<ToastType, string> = {
  success: "bg-white text-slate-900 border-slate-200",
  error: "bg-white text-slate-900 border-red-200",
  warning: "bg-white text-slate-900 border-amber-200",
  info: "bg-white text-slate-900 border-slate-200",
};

const toastIcons: Record<ToastType, ReactNode> = {
  success: (
    <svg className="h-5 w-5 text-green-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
    </svg>
  ),
  error: (
    <svg className="h-5 w-5 text-red-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10 7.293 11.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
    </svg>
  ),
  warning: (
    <svg className="h-5 w-5 text-amber-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
    </svg>
  ),
  info: (
    <svg className="h-5 w-5 text-blue-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
    </svg>
  ),
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const id = useId();
  const descId = `${id}-desc`;

  useEffect(() => {
    if (toast.duration !== 0) {
      const timer = setTimeout(() => onDismiss(toast.id), toast.duration ?? DEFAULT_DURATION);
      return () => clearTimeout(timer);
    }
  }, [toast, onDismiss]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onDismiss(toast.id);
    }
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      aria-describedby={toast.description ? descId : undefined}
      className={`flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-xl border p-4 shadow-lg ${toastStyles[toast.type]}`}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div className="flex-shrink-0 mt-0.5" aria-hidden="true">{toastIcons[toast.type]}</div>
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-semibold">{toast.title}</h4>
        {toast.description && (
          <p id={descId} className="mt-1 text-sm opacity-90">
            {toast.description}
          </p>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="mt-3 text-sm font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-currentColor"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="flex-shrink-0 rounded-md p-1 text-current opacity-50 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-currentColor focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        aria-label={`Dismiss ${toast.type} notification`}
      >
        <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
        </svg>
      </button>
    </div>
  );
}

function ToastList() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[1500] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.slice(-TOAST_LIMIT).map((toast) => (
        <div key={toast.id} className="ui-toast pointer-events-auto">
          <ToastItem toast={toast} onDismiss={dismissToast} />
        </div>
      ))}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // A portal must not be created while the server's page is being hydrated.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const showToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newToast = { ...toast, id };
    setToasts((prev) => [...prev, newToast].slice(-TOAST_LIMIT));
    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    setToasts([]);
  }, []);

  const value = useMemo(
    () => ({ toasts, showToast, dismissToast, dismissAll }),
    [toasts, showToast, dismissToast, dismissAll]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted && createPortal(<ToastList />, document.body)}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

// Convenience hook for common toast patterns
export function useToastHelpers() {
  const { showToast } = useToast();

  return useMemo(
    () => ({
      success: (title: string, description?: string, action?: Toast["action"]) =>
        showToast({ type: "success", title, description, action }),
      error: (title: string, description?: string, action?: Toast["action"]) =>
        showToast({ type: "error", title, description, action }),
      warning: (title: string, description?: string, action?: Toast["action"]) =>
        showToast({ type: "warning", title, description, action }),
      info: (title: string, description?: string, action?: Toast["action"]) =>
        showToast({ type: "info", title, description, action }),
    }),
    [showToast]
  );
}