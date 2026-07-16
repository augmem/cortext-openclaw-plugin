// JUDGED compaction comparison on a REAL conversation.
//
// Full-auto pipeline over a Claude Code transcript:
//   1. convert + ingest the ENTIRE conversation into Cortext (per mode)
//   2. compact — the archived prefix leaves the verbatim window
//   3. auto-generate factual QA probes from ARCHIVED-ONLY snippets (LLM)
//   4. per arm, answer each probe from the post-compaction context:
//        hybrid      = window + Cortext long-term recall
//        full        = window + Cortext recall + working-memory snapshot
//        native      = REAL LLM compaction ablation: the archived prefix is
//                      summarized with OpenClaw's actual structured-summary
//                      contract (iterative re-distill), then window + summary
//        window-only = the same compacted window with NO memory injection
//                      (floor control: window alone)
//   5. LLM judge (LongMemEval-style autoeval) scores each answer
//
// Requires OPENAI_API_KEY. Usage:
//   node bench/replay-judged.mjs <claude-transcript.jsonl> [--probes N] [--limit N]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert, buildEngine } from "./replay-transcript.mjs";
import { judge } from "./judge.mjs";

const MODEL = process.env.BENCH_MODEL_RAW || "gpt-5.4-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const nProbes = Number(args[args.indexOf("--probes") + 1] || 10);
const limit = Number(args[args.indexOf("--limit") + 1] || 0) || Infinity;
if (!file) { console.error("usage: node bench/replay-judged.mjs <claude-transcript.jsonl> [--probes N] [--limit N]"); process.exit(1); }

async function llm(system, user, maxTokens = 300) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_completion_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()).choices?.[0]?.message?.content || "").trim();
}

const text = (m) => Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join(" ") : String(m.content ?? "");

// --- 1. load ---
const all = convert(file).slice(0, limit);
console.log(`replaying ${all.length} messages from ${file.split("/").pop()}`);
const view = [{ role: "system", content: "system prompt placeholder" }, ...all];

// --- helpers to build one arm ---
async function buildArm(mode) {
  const dir = mkdtempSync(join(tmpdir(), `cortext-judged-${mode}-`));
  const eng = buildEngine(dir, { compactionMode: mode, protectTail: 6 });
  const t0 = Date.now();
  let ingested = 0;
  for (const m of all) {
    const r = await eng.ingest({ sessionId: "J", sessionKey: "agent:main:judged", message: m });
    if (r.ingested) ingested++;
  }
  await eng.assemble({ sessionId: "J", sessionKey: "agent:main:judged", messages: view, prompt: "status" });
  const res = await eng.compact({ sessionId: "J", sessionKey: "agent:main:judged" });
  console.log(`[${mode}] ingested ${ingested}/${all.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${res.reason} ~${res.result?.tokensBefore} -> ~${res.result?.tokensAfter} tokens`);
  return { dir, eng };
}

// --- 2/3. archived snippets -> QA probes (from the hybrid arm's cut) --------
const BOILERPLATE = /updated successfully|has been (created|written)|no (output|content)|^\s*ok\b|command running in background|tool ran without/i;
function archivedSnippets(cutIdx) {
  // Candidate snippets strictly BEFORE the cut: real user asks and meaty tool
  // results — the content that leaves the verbatim window. Skip boilerplate
  // tool acks ("File updated successfully") — they yield questions that are
  // unanswerable without seeing the snippet itself.
  const pre = all.slice(0, cutIdx);
  const cands = pre.filter((m) => (m.role === "user" || m.role === "toolResult")
    && text(m).length > 200 && !BOILERPLATE.test(text(m).slice(0, 200)));
  const step = Math.max(1, Math.floor(cands.length / (nProbes * 2)));
  return cands.filter((_, i) => i % step === 0).slice(0, nProbes * 2);
}

async function makeProbe(snippet) {
  const raw = await llm(
    "You write quiz questions. Reply with STRICT JSON: {\"question\": \"...\", \"answer\": \"...\"} and nothing else.",
    `From this conversation snippet, write ONE specific factual question about a concrete detail (a name, value, label, number, or outcome), plus its short answer.

RULES:
- The question must be SELF-CONTAINED: someone who has not seen this snippet must still understand what is being asked. Never say "the snippet", "this message", or "shown above" — name the subject explicitly (e.g. "What needle value did the compaction integration test seed?").
- The answer must be a specific detail from the snippet, not a theme.
- If the snippet has no distinctive, identifiable detail worth asking about, reply {"question": "", "answer": ""}.

Snippet:
${text(snippet).slice(0, 1200)}`,
  );
  try {
    const j = JSON.parse(raw.replace(/^```json?\s*|```$/g, ""));
    if (j.question && j.answer && !/snippet|this message|shown above/i.test(j.question)) {
      return { question: String(j.question), answer: String(j.answer) };
    }
  } catch { /* skip malformed */ }
  return null;
}

// --- native-compaction ablation: OpenClaw's real summarizer contract --------
// Structure + instructions transcribed from the installed openclaw package
// (attempt.model-diagnostic-events: buildCompactionStructureInstructions and
// resolveCompactionInstructions defaults, "strict" identifier policy).
const NATIVE_SUMMARIZER_SYSTEM = [
  "Produce a compact, factual summary with these exact section headings:",
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
  "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).",
  "Do not omit unresolved asks from the user.",
  "When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail.",
  "Write the summary body in the primary language used in the conversation.",
  "Focus on factual content: what was discussed, decisions made, and current state.",
  "Keep the required summary structure and section headers unchanged.",
  "Do not translate or alter code, file paths, identifiers, or error messages.",
].join("\n");

async function nativeCompactionSummary(cutIdx) {
  // Iterative fold, mirroring repeated native compactions over a long
  // conversation: summarize a chunk, then re-distill prior summary + next.
  const CHUNK_CHARS = 60000;
  const pre = all.slice(0, cutIdx);
  const chunks = [];
  let buf = "";
  for (const m of pre) {
    buf += `${m.role}: ${text(m)}\n`;
    if (buf.length >= CHUNK_CHARS) { chunks.push(buf); buf = ""; }
  }
  if (buf.trim()) chunks.push(buf);
  console.log(`native compaction: summarizing ${pre.length} archived messages in ${chunks.length} chunk(s) (real LLM calls)…`);
  let summary = "";
  const t0 = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    summary = await llm(
      NATIVE_SUMMARIZER_SYSTEM,
      (summary ? `Prior compaction summary:\n${summary}\n\n` : "") + `New messages:\n${chunks[i]}`,
      2000,
    );
  }
  console.log(`native compaction: ${chunks.length} summarizer calls in ${((Date.now() - t0) / 1000).toFixed(0)}s (Cortext used 0)`);
  return summary;
}

// --- 4. answer a probe from a post-compaction context ---
async function answer(eng, probe, { memory, summary }) {
  const out = await eng.assemble({ sessionId: "J", sessionKey: "agent:main:judged", messages: view, prompt: probe.question });
  const windowText = out.messages
    .map((m) => `${m.role}: ${text(m).slice(0, 600)}`)
    .join("\n")
    .slice(0, 24000);
  const head = memory && out.systemPromptAddition ? `${out.systemPromptAddition}\n\n`
    : summary ? `--- compaction summary of the earlier conversation ---\n${summary}\n\n`
    : "";
  const context = `${head}--- conversation window ---\n${windowText}`;
  return llm(
    "Answer using ONLY the provided context. If the context does not contain the answer, reply exactly: I don't know.",
    `${context}\n\nQuestion: ${probe.question}\nAnswer briefly.`,
    120,
  );
}

// --- run ---
const hybrid = await buildArm("hybrid");
const full = await buildArm("full");

// Cut index for snippet sampling: recompute the same way the engine did.
const { chooseCut } = await import("../dist/compaction.js");
const cutIdx = chooseCut(view, "hybrid", 6) - 1; // -1: view has the system msg prepended
console.log(`sampling archived snippets from the first ${cutIdx} messages`);
const probes = [];
for (const s of archivedSnippets(cutIdx)) {
  if (probes.length >= nProbes) break;
  const p = await makeProbe(s);
  if (p) probes.push(p);
}
console.log(`generated ${probes.length} QA probes from archived content\n`);

const nativeSum = await nativeCompactionSummary(cutIdx);
console.log(`native summary: ~${Math.round(nativeSum.length / 4)} tokens\n`);

const arms = [
  { name: "hybrid (window + LTM recall)", eng: hybrid.eng, memory: true },
  { name: "full (window + LTM + WM)", eng: full.eng, memory: true },
  { name: "native compaction (LLM summary + window)", eng: hybrid.eng, memory: false, summary: nativeSum },
  { name: "window-only control (no memory)", eng: hybrid.eng, memory: false },
];
const scores = {};
for (const arm of arms) {
  let correct = 0;
  for (const p of probes) {
    const hyp = await answer(arm.eng, p, { memory: arm.memory, summary: arm.summary });
    const ok = await judge("single-session-user", p.question, p.answer, hyp);
    if (ok) correct++;
    console.log(`  [${arm.name}] ${ok ? "✓" : "✗"} ${p.question.slice(0, 70)} -> ${hyp.slice(0, 60)}`);
  }
  scores[arm.name] = correct;
  console.log(`${arm.name}: ${correct}/${probes.length}\n`);
}

console.log("=== JUDGED RESULTS (archived-content QA, LLM judge) ===");
for (const [name, s] of Object.entries(scores)) console.log(`${name}: ${s}/${probes.length}`);

rmSync(hybrid.dir, { recursive: true, force: true });
rmSync(full.dir, { recursive: true, force: true });
