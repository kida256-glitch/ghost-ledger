// Environment parsing (tech.md: env vars are parsed once with zod, here).
import { z } from "zod";

const postgresUrl = z
  .string()
  .url()
  .refine((u) => /^postgres(ql)?:\/\//.test(u), "must be a postgres:// or postgresql:// URL");

const optionalUrl = postgresUrl.optional();

/** Every database variable this spec defines (design §10). All optional here; consumers require what they use. */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  /** ghost_app through the transaction pooler: the app runtime. */
  DATABASE_URL: optionalUrl,
  /** ghost_readonly through the transaction pooler: MCP server and agent. */
  READONLY_DATABASE_URL: optionalUrl,
  /** Table owner, direct connection: migrations, seed, db:roles-login, demo scripts. Never the app. */
  ADMIN_DATABASE_URL: optionalUrl,
  /** PEM text of the Supabase CA; required for any non-local database (design §14.2). Public, not a secret. */
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE", { message: "must be a PEM certificate" }).optional(),
  /** Supabase project URL, for Supabase Auth (dashboard sign-in, server only). */
  SUPABASE_URL: z.string().url().refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL").optional(),
  /** Publishable (anon) key, server only: anon has no table grants (ledger-core R13.9). */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20, "must be the project's publishable key").optional(),
  /** If set, the login page shows the demo leaders' password (dashboard-simulator D1.9). */
  DEMO_LEADER_PASSWORD_HINT: z.string().min(1).max(100).optional(),
  /** Must never be set where the app runs (README). Read only by the seed script. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/** Parses the environment. Error messages name variables, never their values. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat empty strings (common in .env files) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const r = envSchema.safeParse(cleaned);
  if (!r.success) {
    throw new EnvError(`invalid environment: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

/**
 * The app runtime's view: DATABASE_URL is required, and the Supabase
 * service-role key must be absent (it bypasses RLS and every grant).
 */
export function appEnv(source: Record<string, string | undefined> = process.env): Env & { DATABASE_URL: string } {
  const env = parseEnv(source);
  if (env.SUPABASE_SERVICE_ROLE_KEY !== undefined) {
    throw new EnvError(SERVICE_KEY_REFUSAL);
  }
  if (env.DATABASE_URL === undefined) throw new EnvError("DATABASE_URL is required");
  return { ...env, DATABASE_URL: env.DATABASE_URL };
}

const SERVICE_KEY_REFUSAL = "SUPABASE_SERVICE_ROLE_KEY must not be set in the app's environment";

/** The read-only consumers' view (/api/health, MCP server, agent). Also refuses the service-role key. */
export function readonlyEnv(source: Record<string, string | undefined> = process.env): Env & { READONLY_DATABASE_URL: string } {
  const env = parseEnv(source);
  if (env.SUPABASE_SERVICE_ROLE_KEY !== undefined) throw new EnvError(SERVICE_KEY_REFUSAL);
  if (env.READONLY_DATABASE_URL === undefined) throw new EnvError("READONLY_DATABASE_URL is required");
  return { ...env, READONLY_DATABASE_URL: env.READONLY_DATABASE_URL };
}

/** Admin scripts' view: ADMIN_DATABASE_URL required. */
export function adminEnv(source: Record<string, string | undefined> = process.env): Env & { ADMIN_DATABASE_URL: string } {
  const env = parseEnv(source);
  if (env.ADMIN_DATABASE_URL === undefined) throw new EnvError("ADMIN_DATABASE_URL is required");
  return { ...env, ADMIN_DATABASE_URL: env.ADMIN_DATABASE_URL };
}

/** Dashboard auth's view: the Supabase URL and publishable key, and never the service-role key (D1.7). */
export function authEnv(source: Record<string, string | undefined> = process.env): Env & { SUPABASE_URL: string; SUPABASE_PUBLISHABLE_KEY: string } {
  const env = parseEnv(source);
  if (env.SUPABASE_SERVICE_ROLE_KEY !== undefined) throw new EnvError(SERVICE_KEY_REFUSAL);
  if (env.SUPABASE_URL === undefined) throw new EnvError("SUPABASE_URL is required");
  if (env.SUPABASE_PUBLISHABLE_KEY === undefined) throw new EnvError("SUPABASE_PUBLISHABLE_KEY is required");
  return { ...env, SUPABASE_URL: env.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY };
}
