// Session refresh for middleware (Supabase SSR guide, Next.js 15 `middleware.ts`).
// The client factory is injected so the cookie and header copying is testable.
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };
export interface CookieMethods {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: CookieToSet[], headers: Record<string, string>) => void;
}
/** Anything with `auth.getClaims()`; the real one is @supabase/ssr's server client. */
export type ClientFactory = (cookies: CookieMethods) => { auth: { getClaims: () => Promise<unknown> } };

export async function refreshSession(request: NextRequest, makeClient: ClientFactory): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const client = makeClient({
    getAll: () => request.cookies.getAll(),
    setAll: (list, headers) => {
      for (const { name, value } of list) request.cookies.set(name, value);
      // Rebuild the response so Server Components see the refreshed cookies, then send them to the browser.
      response = NextResponse.next({ request });
      for (const { name, value, options } of list) response.cookies.set(name, value, options);
      // Cache-Control, Expires, Pragma: a response with Set-Cookie must never be cached (design §3).
      for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
    },
  });
  try {
    // Refreshes an expiring token and verifies it. The result itself is not needed here.
    await client.auth.getClaims();
  } catch {
    // A broken Auth call must not break the page; the page's own check redirects to /login.
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
