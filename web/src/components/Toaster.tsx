import { useEffect, useState } from 'react';

export interface ToastInput {
  title: string;
  body?: string;
  icon?: string;
}

type ToastItem = ToastInput & { id: number };
type Listener = (toast: ToastItem) => void;

const listeners = new Set<Listener>();
let nextId = 1;

/** Shows a brief, non-blocking message (announced politely to screen readers). */
export function toast(input: ToastInput): void {
  const item = { ...input, id: nextId++ };
  for (const listener of listeners) listener(item);
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const listener: Listener = (item) => {
      setItems((current) => [...current.slice(-2), item]);
      window.setTimeout(() => setItems((current) => current.filter((t) => t.id !== item.id)), 4200);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.icon ? <span className="toast__icon" aria-hidden="true">{t.icon}</span> : null}
          <div>
            <strong>{t.title}</strong>
            {t.body ? <span className="small muted">{t.body}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
