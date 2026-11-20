// PIN rules and hashing (ussd-engine design §4, §11). PINs and hashes are
// never logged or shown.
import { hash, verify } from "@node-rs/argon2";

export const PIN_LENGTH = 4;

export type PinProblem = "PIN_FORMAT" | "PIN_SAME_DIGITS" | "PIN_SEQUENCE" | "PIN_PHONE";

/** U6.2: null if `pin` is acceptable for a member with this phone number. */
export function checkNewPin(pin: string, phone: string): PinProblem | null {
  if (!/^\d{4}$/.test(pin)) return "PIN_FORMAT";
  if (/^(\d)\1{3}$/.test(pin)) return "PIN_SAME_DIGITS";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "PIN_SEQUENCE";
  if (phone.endsWith(pin)) return "PIN_PHONE";
  return null;
}

export interface PinHasher {
  hash(pin: string): Promise<string>;
  verify(pinHash: string, pin: string): Promise<boolean>;
}

/**
 * argon2id cost (design §11.1). The OWASP minimum, kept because one verify
 * takes well under 100 ms (measured with `npm run ussd:argon2-timing`).
 * Changing these changes new hashes only; stored hashes carry their own.
 */
export const PIN_HASH_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** argon2id (the library's default algorithm) via @node-rs/argon2. */
export const argon2PinHasher: PinHasher = {
  hash: (pin) => hash(pin, PIN_HASH_OPTIONS),
  // A malformed stored hash counts as a wrong PIN, never an exception.
  verify: (pinHash, pin) => verify(pinHash, pin).catch(() => false),
};
