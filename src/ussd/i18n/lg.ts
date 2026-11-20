// Luganda: main screens only; everything else falls back to English (U13.2, U13.3).
//
// DRAFT: none of these strings has been reviewed by a native speaker yet.
// Each entry below carries the marker; a test checks it. Remove the marker
// from an entry only after review. GSM-7 only: write ng' instead of the eng letter.
import type { PartialMessages } from "./types";

export const LUGANDA_DRAFT_MARKER = "DRAFT: not reviewed by a native speaker";

export const lg: PartialMessages = {
  // DRAFT: not reviewed by a native speaker
  NOT_REGISTERED: () => "Ennamba eno tewandiisibwa. Saba omukulembeze w'ekibiina kyo akuwandiise.",
  // DRAFT: not reviewed by a native speaker
  PIN_CREATE: ({ name }) => `Tukwaniriza ${name}. Kola PIN ey'ennamba 4:`,
  // DRAFT: not reviewed by a native speaker
  PIN_CONFIRM: () => "Yingiza PIN y'emu nate:",
  // DRAFT: not reviewed by a native speaker
  PIN_ENTER: () => "Ghost Ledger. Yingiza PIN yo:",
  // DRAFT: not reviewed by a native speaker
  PIN_WRONG: ({ left }) => `PIN si ntuufu. Osigazza emirundi ${left}.`,
  // DRAFT: not reviewed by a native speaker
  MAIN: () => "1 Tereka\n2 Saba looni\n3 Sasula\n4 Bbalansi\n5 Ebikwata ku kibiina\n6 Olulimi",
  // DRAFT: not reviewed by a native speaker
  BALANCE: ({ savings, pending, pendingCount, socialFund, owed, due, limit }) =>
    `Eziterekeddwa ${savings}\nEzirindiridde ${pending} (${pendingCount})\nSocial fund ${socialFund}\nLooni ${owed ?? "UGX 0"}${due ? ` ${due}` : ""}\nGy'osobola ${limit}`,
  // DRAFT: not reviewed by a native speaker
  SAVE_CONFIRM: ({ amount }) => `Tereka ${amount}? Omukulembeze ajja kukakasa.\n1 Kakasa\n2 Sazaamu`,
  // DRAFT: not reviewed by a native speaker
  SAVE_DONE: ({ amount, pending }) => `Okusaba kuweereddwa: ${amount}. Omukulembeze ajja kukakasa. Ebirindiridde: ${pending}.`,
  // DRAFT: not reviewed by a native speaker
  LOAN_CONFIRM: ({ principal, months, interest, total }) =>
    `Weewole ${principal} okumala emyezi ${months}? Amagoba ${interest}, awamu ${total}.\n1 Kakasa\n2 Sazaamu`,
  // DRAFT: not reviewed by a native speaker
  LOAN_DONE: () => "Okusaba looni kuweereddwa. Omukulembeze alina okukakasa nga tonnaweebwa ssente.",
  // DRAFT: not reviewed by a native speaker
  LANG_DONE: () => "Olulimi lukyusiddwa ku Luganda.",
};
