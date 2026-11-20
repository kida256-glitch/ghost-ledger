// npm run ussd:argon2-timing
//
// Times one argon2id PIN verify for a few cost settings (ussd-engine design §11).
// The engine uses PIN_HASH_OPTIONS; this prints the median and worst of 20
// verifies for it and for nearby settings, so the choice can be re-checked on
// any machine (including inside the Linux container in task 4).
import { hash, verify } from "@node-rs/argon2";
import { PIN_HASH_OPTIONS } from "../src/ussd/pin";

const CANDIDATES = [
  { label: "OWASP minimum (m=19456, t=2, p=1)", memoryCost: 19_456, timeCost: 2, parallelism: 1 },
  { label: "m=46080, t=1, p=1 (OWASP alternative)", memoryCost: 46_080, timeCost: 1, parallelism: 1 },
  { label: "m=65536, t=3, p=1", memoryCost: 65_536, timeCost: 3, parallelism: 1 },
];

async function time(opts: { memoryCost: number; timeCost: number; parallelism: number }) {
  const h = await hash("2580", opts);
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await verify(h, i % 2 === 0 ? "2580" : "2581");
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { median: ms[10] ?? 0, worst: ms[19] ?? 0 };
}

const chosen = await time(PIN_HASH_OPTIONS);
console.log(`chosen ${JSON.stringify(PIN_HASH_OPTIONS)}: median ${chosen.median.toFixed(1)} ms, worst ${chosen.worst.toFixed(1)} ms`);
for (const c of CANDIDATES) {
  const r = await time(c);
  console.log(`${c.label}: median ${r.median.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms`);
}
