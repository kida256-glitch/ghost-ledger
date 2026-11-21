"use server";
// Sign-in and sign-out (D1.1, D1.6). Server actions only: no Supabase client in the browser.
import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "../../lib/auth/supabase-server";

export type SignInState = { error: string | null };

const form = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });

export async function signIn(_prev: SignInState, data: FormData): Promise<SignInState> {
  const parsed = form.safeParse({ email: data.get("email"), password: data.get("password") });
  if (!parsed.success) return { error: "Enter your email and password." };
  let ok = false;
  try {
    const sb = await supabaseServer();
    const { error } = await sb.auth.signInWithPassword(parsed.data);
    ok = !error;
  } catch {
    return { error: "Sign-in is unavailable right now. Please try again." };
  }
  // The same message for every failure: it says nothing about which accounts exist.
  if (!ok) return { error: "Email or password is wrong." };
  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  try {
    const sb = await supabaseServer();
    await sb.auth.signOut();
  } catch {
    // The cookies are cleared below in any case.
  }
  redirect("/login");
}
