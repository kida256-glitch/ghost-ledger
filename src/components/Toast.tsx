"use client";
// Success messages that outlive the form that sent them: after a write the page
// refreshes and the item (e.g. a confirmed deposit) leaves the list (D13.4).
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

const ToastContext = createContext<(message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const show = useCallback((message: string) => setToast({ id: Date.now(), message }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-20 z-20 flex justify-center px-4 md:bottom-6">
        {toast ? (
          <div key={toast.id} className="ecto-glow pointer-events-auto max-w-md rounded-xl border border-ecto-dim bg-surface px-4 py-3 text-sm text-ecto shadow-xl" data-testid="toast">
            {toast.message}
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
