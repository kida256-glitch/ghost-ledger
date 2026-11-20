// Structured logging. Callers pass records made only of fixed words
// (ussd-engine U8); this module never adds request data.
export function logJson(record: Readonly<Record<string, string>>): void {
  console.log(JSON.stringify(record));
}
