// Demo PINs for the fictional TUBEERA group (ussd-engine U17.1). Shown on the
// simulator page so judges can dial in; never use these for real people.
// One member, Waiswa Henry, has none, so the first-dial PIN setup can be shown.
import type { Uuid } from "../domain";

/** Seed member id → PIN. Ids come from buildSeed's member counter (3e3be000-5eed-…-N). */
export const DEMO_PINS: Readonly<Record<Uuid, string>> = {
  "3e3be000-5eed-4000-8000-000000000001": "2580", // Nakato Sarah, chair
  "3e3be000-5eed-4000-8000-000000000002": "1357", // Ssempala Joseph, treasurer
  "3e3be000-5eed-4000-8000-000000000003": "2468", // Namubiru Grace, secretary
  "3e3be000-5eed-4000-8000-000000000004": "3691", // Okello David
  "3e3be000-5eed-4000-8000-000000000005": "4826", // Nansubuga Ruth
  "3e3be000-5eed-4000-8000-000000000006": "5937", // Mugisha Peter
  "3e3be000-5eed-4000-8000-000000000007": "6148", // Achieng Mary
  "3e3be000-5eed-4000-8000-000000000008": "7259", // Kato Ivan
  "3e3be000-5eed-4000-8000-000000000009": "8360", // Nalwoga Esther
  "3e3be000-5eed-4000-8000-00000000000a": "9471", // Tumusiime Paul
  "3e3be000-5eed-4000-8000-00000000000b": "1593", // Birungi Joan
};

/** The member left without a PIN for the first-dial demo. */
export const DEMO_FIRST_DIAL_MEMBER_ID: Uuid = "3e3be000-5eed-4000-8000-00000000000c"; // Waiswa Henry
