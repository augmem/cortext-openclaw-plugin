// Downloads the LongMemEval dataset (cleaned) from HuggingFace into bench/data/.
// Default: the `oracle` variant (evidence sessions only — smallest/cheapest to
// run). Pass `s` or `m` for the full-haystack variants.
//   node fetch-longmemeval.mjs [oracle|s|m]
import { mkdirSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const BENCH = dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2] || "oracle";
const file = { oracle: "longmemeval_oracle.json", s: "longmemeval_s_cleaned.json", m: "longmemeval_m_cleaned.json" }[variant];
if (!file) { console.error(`unknown variant "${variant}" (use oracle|s|m)`); process.exit(1); }

const url = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/${file}`;
mkdirSync(join(BENCH, "data"), { recursive: true });
const dest = join(BENCH, "data", file);

console.log(`downloading ${file}…`);
const res = await fetch(url);
if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
await new Promise((resolve, reject) => {
  const out = createWriteStream(dest);
  Readable.fromWeb(res.body).pipe(out).on("finish", resolve).on("error", reject);
});
console.log(`saved ${dest}`);
