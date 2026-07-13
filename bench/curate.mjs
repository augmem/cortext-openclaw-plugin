#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? +process.argv[i + 1] : d; };
const per = arg('--per', 8), absMin = arg('--abs', 6);
const CATS = ['temporal-reasoning', 'multi-session', 'knowledge-update', 'single-session-preference', 'single-session-assistant', 'single-session-user'];

const data = JSON.parse(readFileSync(join(dir, 'data/longmemeval_oracle.json'), 'utf8'));
const rows = data.map(d => {
  const turns = d.haystack_sessions.reduce((a, s) => a + s.length, 0);
  const chars = d.haystack_sessions.reduce((a, s) => a + s.reduce((b, t) => b + t.content.length, 0), 0);
  return {
    question_id: d.question_id, question_type: d.question_type,
    is_abstention: d.question_id.endsWith('_abs'),
    num_sessions: d.haystack_sessions.length, num_turns: turns, est_tokens: Math.ceil(chars / 4),
  };
});
const cmp = (a, b) => a.est_tokens - b.est_tokens || a.num_sessions - b.num_sessions || (a.question_id < b.question_id ? -1 : 1);

const picked = new Map();
for (const c of CATS)
  for (const r of rows.filter(r => r.question_type === c).sort(cmp).slice(0, per)) picked.set(r.question_id, r);
const absHave = () => [...picked.values()].filter(r => r.is_abstention).length;
for (const r of rows.filter(r => r.is_abstention && !picked.has(r.question_id)).sort(cmp)) {
  if (absHave() >= absMin) break;
  picked.set(r.question_id, r);
}
const subset = [...picked.values()].sort((a, b) => CATS.indexOf(a.question_type) - CATS.indexOf(b.question_type) || cmp(a, b));
writeFileSync(join(dir, 'data/curated-subset.json'), JSON.stringify(subset, null, 2));

const stat = (arr, k) => { const v = arr.map(x => x[k]).sort((a, b) => a - b); return `${v[0]}/${v[Math.floor(v.length / 2)]}/${v[v.length - 1]}`; };
console.log(`Selected ${subset.length} instances (per=${per}, abs>=${absMin}, have ${absHave()} abstention)\n`);
console.log('Category                       count');
for (const c of CATS) console.log(c.padEnd(30), subset.filter(r => r.question_type === c).length);
console.log('\n                 est_tokens(min/med/max)  num_sessions(min/med/max)');
console.log('subset  ', stat(subset, 'est_tokens').padEnd(24), stat(subset, 'num_sessions'));
console.log('full    ', stat(rows, 'est_tokens').padEnd(24), stat(rows, 'num_sessions'));
const total = subset.reduce((a, r) => a + r.est_tokens, 0);
console.log(`\nTOTAL est ingest tokens (subset): ${total}`);
console.log(`Mean est_tokens subset=${Math.round(total / subset.length)} full=${Math.round(rows.reduce((a, r) => a + r.est_tokens, 0) / rows.length)}`);
