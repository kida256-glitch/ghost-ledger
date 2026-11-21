// Pure helpers for the phone simulator (D12). No imports from the domain or the
// database: this runs in the browser.

export const SERVICE_CODE = "*384*123#";

/** The form body a gateway would POST: every step so far joined by `*` (D12.1). */
export function ussdForm(sessionId: string, phoneNumber: string, steps: readonly string[]): string {
  return new URLSearchParams({ sessionId, serviceCode: SERVICE_CODE, phoneNumber, text: steps.join("*") }).toString();
}

export type Reply = { readonly kind: "CON" | "END"; readonly body: string };

/** Splits off the CON/END prefix. Anything else is treated as a session end. */
export function parseReply(raw: string): Reply {
  if (raw.startsWith("CON ")) return { kind: "CON", body: raw.slice(4) };
  if (raw.startsWith("END ")) return { kind: "END", body: raw.slice(4) };
  return { kind: "END", body: raw };
}

/** D12.4: a step that answers a prompt asking for a PIN is shown as ****. */
export function maskStep(step: string, prompt: string): string {
  return /\bPIN\b/.test(prompt) ? "*".repeat(Math.max(4, step.length)) : step;
}

/** D12.6: the reply is the rate-limit screen in one of the registered languages. */
export function isRateLimited(raw: string, rateLimitedScreens: readonly string[]): boolean {
  return rateLimitedScreens.includes(raw);
}

/** A fresh session id per dial, like a gateway's. */
export function newSessionId(random: () => string = () => crypto.randomUUID()): string {
  return `sim-${random()}`;
}
