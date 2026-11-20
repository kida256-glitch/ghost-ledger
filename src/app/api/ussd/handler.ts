// POST /api/ussd logic (ussd-engine design §9), outside route.ts so it can be
// tested without Next.js.
import { z } from "zod";
import { handleUssd, type UssdDeps } from "../../../ussd/engine";
import { render, screen } from "../../../ussd/screens";

/** U1.1, U1.2. Extra gateway fields (networkCode, …) are ignored. */
export const ussdForm = z.object({
  sessionId: z.string().min(1).max(100),
  serviceCode: z.string().min(1).max(30),
  phoneNumber: z.string().min(1).max(20),
  text: z.string().max(1000),
});

export interface UssdHttpResult {
  readonly status: 200;
  readonly body: string;
}

const GENERIC = () => render("en", screen("ERROR", {}));

/** Always HTTP 200 with one screen, as gateways expect. Never throws. */
export async function ussdHttp(rawBody: string, getDeps: () => UssdDeps, logError: (record: Record<string, string>) => void): Promise<UssdHttpResult> {
  const params = new URLSearchParams(rawBody);
  const parsed = ussdForm.safeParse({
    sessionId: params.get("sessionId") ?? undefined,
    serviceCode: params.get("serviceCode") ?? undefined,
    phoneNumber: params.get("phoneNumber") ?? undefined,
    text: params.get("text") ?? undefined,
  });
  if (!parsed.success) {
    logError({ event: "ussd", screen: "ERROR", outcome: "rejected", code: "bad_request" });
    return { status: 200, body: GENERIC() };
  }
  let deps: UssdDeps;
  try {
    deps = getDeps();
  } catch {
    logError({ event: "ussd", screen: "ERROR", outcome: "internal_error", code: "config" });
    return { status: 200, body: GENERIC() };
  }
  return { status: 200, body: await handleUssd(parsed.data, deps) };
}
