"use client";
import { useActionState } from "react";
import { buttonClass, inputClass } from "../../components/ui";
import { signIn, type SignInState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { error: null });
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm text-muted">Email</span>
        <input name="email" type="email" autoComplete="username" required className={inputClass} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm text-muted">Password</span>
        <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </label>
      <p aria-live="polite" className="min-h-5 text-sm text-danger">
        {state.error}
      </p>
      <button type="submit" disabled={pending} className={`${buttonClass("primary")} w-full`}>
        {pending ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
