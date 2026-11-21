"use client";
// A form wired to a dashboard server action (D13). Shows the pending state and
// the action's message, and sends a fresh idempotency key per submission (D13.3).
import { useActionState, useEffect, useState, type ReactNode } from "react";
import type { ActionResult } from "../app/dashboard/_lib/actions-core";
import { useToast } from "./Toast";
import { buttonClass } from "./ui";

type Action = (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;

function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `dash:${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function ActionForm({
  action,
  hidden = {},
  submitLabel,
  pendingLabel = "Saving...",
  variant = "primary",
  children,
  className,
  resetOnSuccess = true,
  testId,
}: {
  action: Action;
  hidden?: Record<string, string>;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  children?: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  testId?: string;
}) {
  const toast = useToast();
  // Toast from here, not from an effect: on success the page refreshes and this form may
  // already be gone (e.g. a confirmed deposit leaves the list) before effects run.
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(async (prev, form) => {
    const r = await action(prev, form);
    if (r.ok) toast(r.message);
    return r;
  }, null);
  const [key, setKey] = useState("");
  const [formKey, setFormKey] = useState(0);
  // Generated in the browser after mount, so server and client HTML match.
  useEffect(() => setKey(newKey()), []);
  useEffect(() => {
    if (state?.ok) {
      setKey(newKey());
      if (resetOnSuccess) setFormKey((k) => k + 1);
    }
  }, [state, resetOnSuccess]);
  return (
    <form key={formKey} action={formAction} className={className} data-testid={testId}>
      <input type="hidden" name="idempotencyKey" value={key} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <button type="submit" disabled={pending || key === ""} className={`${buttonClass(variant)} w-full sm:w-auto`}>
        {pending ? pendingLabel : submitLabel}
      </button>
      <p aria-live="polite" role="status" className={`mt-2 min-h-5 text-sm ${state === null ? "" : state.ok ? "text-ecto" : "text-danger"}`}>
        {state?.message}
        {state && !state.ok ? <span className="ml-2 font-mono text-xs text-muted">{state.code}</span> : null}
      </p>
    </form>
  );
}
