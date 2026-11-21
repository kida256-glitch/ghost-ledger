// Server-side Supabase Auth (dashboard-simulator design §3). No Supabase client
// ever runs in the browser, and this client is used for auth only: the
// publishable key maps to `anon`, which can read no table.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authEnv } from "../env";

export async function supabaseServer() {
  const env = authEnv();
  const store = await cookies();
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        // Server Components can't set cookies; the middleware refreshes them instead.
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // ignored on purpose
        }
      },
    },
  });
}

/** The verified Auth user id (`sub`), or null with no valid session. getClaims verifies the JWT signature. */
export async function getAuthUserId(): Promise<string | null> {
  try {
    const sb = await supabaseServer();
    const { data, error } = await sb.auth.getClaims();
    const sub = data?.claims?.sub;
    return error || typeof sub !== "string" ? null : sub;
  } catch {
    return null;
  }
}
