// Language registry (U13). Adding a language: add a file and one line here.
import type { UssdLanguage } from "../../db/ussd-repo";
import { en } from "./en";
import { lg } from "./lg";
import type { ErrorId, ErrorParams, Messages, PartialMessages, ScreenId, ScreenParams } from "./types";

export const CATALOGUES: Readonly<Record<UssdLanguage, PartialMessages>> = { en, lg };

/** The message for `id` in `lang`, or English when that language lacks it. */
export function message<K extends ScreenId>(lang: UssdLanguage, id: K, params: ScreenParams[K]): string {
  const own = CATALOGUES[lang][id] as ((p: ScreenParams[K]) => string) | undefined;
  return (own ?? (en[id] as (p: ScreenParams[K]) => string))(params);
}

export function errorLine<K extends ErrorId>(lang: UssdLanguage, id: K, params: ErrorParams[K]): string {
  const own = CATALOGUES[lang].errors?.[id] as ((p: ErrorParams[K]) => string) | undefined;
  return (own ?? (en.errors[id] as (p: ErrorParams[K]) => string))(params);
}

export { en, lg };
export type { ErrorId, ErrorParams, Messages, ScreenId, ScreenParams };
