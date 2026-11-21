// The demo panel's list (D12.3): seed member names and phones with their demo PINs.
import { buildSeed } from "../../seed/build-seed";
import { DEMO_PINS } from "../../seed/demo-pins";
import type { DemoMember } from "./Phone";

// Any anchor gives the same members and phones; only entry dates depend on it.
const SEED_MEMBERS = buildSeed("2026-11-20").members;

export function demoMembers(): DemoMember[] {
  return SEED_MEMBERS.map((m) => ({ name: m.displayName, role: m.role, phone: m.phone, pin: DEMO_PINS[m.id] ?? null }));
}
