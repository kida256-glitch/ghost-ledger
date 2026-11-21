// Refreshes the Supabase Auth session on dashboard requests (design §3).
// Next.js 15 calls this file `middleware.ts`; Next 16 renames it `proxy.ts`.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authEnv } from "./lib/env";
import { refreshSession } from "./lib/auth/refresh-session";

export async function middleware(request: NextRequest) {
  let env;
  try {
    env = authEnv();
  } catch {
    return NextResponse.next({ request });
  }
  return refreshSession(request, (cookies) => createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, { cookies }));
}

export const config = {
  matcher: ["/dashboard/:path*", "/login"],
};
