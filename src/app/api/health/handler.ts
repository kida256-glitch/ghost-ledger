// GET /api/health logic (design §14.3), kept out of route.ts so it can be
// tested without Next.js. Route files may only export route fields.
import type { ChainHealth } from "../../../db/health";

export type HealthBody = (ChainHealth & { region: string | null }) | { status: "error" };

export interface HealthDeps {
  check: () => Promise<ChainHealth>;
  region: string | null;
  /** Gets only the error class and code, never the message (it can contain connection details). */
  logError: (line: string) => void;
}

export async function healthResponse(deps: HealthDeps): Promise<{ status: number; body: HealthBody }> {
  try {
    const h = await deps.check();
    return { status: h.status === "not_seeded" ? 404 : 200, body: { ...h, region: deps.region } };
  } catch (e) {
    const name = e instanceof Error ? e.name : typeof e;
    const code = (e as { code?: unknown } | null)?.code;
    deps.logError(`health check failed: ${name}${typeof code === "string" ? ` ${code}` : ""}`);
    return { status: 503, body: { status: "error" } };
  }
}
