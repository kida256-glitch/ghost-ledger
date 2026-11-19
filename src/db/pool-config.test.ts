import { describe, expect, it } from "vitest";
import { readonlyEnv } from "../lib/env";
import { PoolConfigError, poolConfig } from "./db";

const CA = "-----BEGIN CERTIFICATE-----\nMIIDxTCCAq2gAwIBAgIBADANBgkqhkiG9w0BAQsFADA=\n-----END CERTIFICATE-----\n";
const POOLER = "postgresql://ghost_app.abcdefghijklmnop:s3cret-pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";

describe("task 30: poolConfig (design §14.2)", () => {
  it.each(["postgresql://postgres:postgres@127.0.0.1:56322/postgres", "postgres://u:p@localhost:5432/db", "postgres://u:p@[::1]:5432/db"])(
    "a local host (%s) connects without TLS, max 1",
    (url) => {
      expect(poolConfig(url)).toMatchObject({ ssl: false, max: 1 });
    },
  );

  it("a remote host without the CA is refused, naming the variable and host but not the password", () => {
    expect(() => poolConfig(POOLER)).toThrow(PoolConfigError);
    expect(() => poolConfig(POOLER, { caCert: "not a pem" })).toThrow(/DATABASE_CA_CERT .* aws-0-eu-central-1\.pooler\.supabase\.com/);
    const message = (() => {
      try {
        poolConfig(POOLER);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(message).toContain("DATABASE_CA_CERT");
    expect(message).not.toContain("s3cret");
  });

  it("a remote host with the CA verifies the certificate and hostname (verify-full), max 1", () => {
    const c = poolConfig(POOLER, { caCert: CA });
    expect(c.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
    expect(c.max).toBe(1);
    // No checkServerIdentity override: Node's default hostname check stays on.
    expect(c.ssl).not.toHaveProperty("checkServerIdentity");
  });

  it("sslmode and the other libpq TLS parameters are stripped so they can't override the ssl object; other parameters stay", () => {
    const c = poolConfig(`${POOLER}?sslmode=disable&sslrootcert=x.crt&sslcert=c&sslkey=k&uselibpqcompat=true&application_name=gl`, { caCert: CA });
    const u = new URL(c.connectionString as string);
    expect([...u.searchParams.keys()]).toEqual(["application_name"]);
    expect(u.password).toBe("s3cret-pw");
  });

  it("an invalid URL is refused without echoing it", () => {
    expect(() => poolConfig("::not a url s3cret")).toThrow("database URL is not a valid URL");
  });

  it("max can be raised only explicitly (scripts), never by default", () => {
    expect(poolConfig(POOLER, { caCert: CA, max: 4 }).max).toBe(4);
  });
});

describe("task 30: readonlyEnv also refuses the service-role key (design §14.2)", () => {
  it("throws with the key present and accepts the same env without it", () => {
    const env = { READONLY_DATABASE_URL: POOLER.replace("ghost_app", "ghost_readonly"), DATABASE_CA_CERT: CA };
    expect(() => readonlyEnv({ ...env, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" })).toThrow("SUPABASE_SERVICE_ROLE_KEY must not be set");
    expect(readonlyEnv(env).DATABASE_CA_CERT).toBe(CA);
  });

  it("rejects a DATABASE_CA_CERT that isn't a PEM certificate", () => {
    expect(() => readonlyEnv({ READONLY_DATABASE_URL: POOLER, DATABASE_CA_CERT: "abc" })).toThrow(/DATABASE_CA_CERT/);
  });
});
