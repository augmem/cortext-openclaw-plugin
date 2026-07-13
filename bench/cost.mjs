// Cost accounting for the OpenClaw memory benchmark.
// Dependency-free. Reports call/turn counts only — never dollar prices,
// since model prices drift and live in OpenClaw's catalog, not here.
//
// Per instance, per arm: run `num_sessions` INGEST turns (feed a session
// transcript, discard a short reply) + 1 PROBE turn. Ingest turns don't need
// a smart reply, so they run on the cheap model; probes use the main model.
// Judge votes then call OpenAI once per probe per vote.

// Cheapest valid OpenClaw openai model id (catalog: gpt-5.4-nano @ 0.2/1.25,
// gpt-5.4-mini @ 0.75/4.5). No gpt-5-nano entry exists, so nano it is.
export const INGEST_MODEL = "openai/gpt-5.4-nano";
export const PROBE_MODEL = process.env.BENCH_MODEL || "openai/gpt-5.4-mini";

export function estimateCost(sample, arms, opts = {}) {
  const votes = opts.votes ?? 3;
  const seeds = opts.seeds ?? 1;
  const nArms = arms.length;
  const nInst = sample.length;

  const sessionsPerSeed = sample.reduce((s, i) => s + (i.num_sessions || 0), 0);
  const ingestTurns = sessionsPerSeed * nArms * seeds;
  const probeTurns = nInst * nArms * seeds;
  const judgeCalls = probeTurns * votes;
  const totalAgentTurns = ingestTurns + probeTurns;

  const byModel = {};
  byModel[INGEST_MODEL] = (byModel[INGEST_MODEL] || 0) + ingestTurns;
  byModel[PROBE_MODEL] = (byModel[PROBE_MODEL] || 0) + probeTurns;

  const perArm = arms.map((a) => ({
    name: a.name,
    ingestTurns: sessionsPerSeed * seeds,
    probeTurns: nInst * seeds,
    judgeCalls: nInst * seeds * votes,
  }));

  // Estimated ingest input tokens, only if est_tokens is provided on the sample.
  // est_tokens is the per-instance TOTAL across all its sessions (the whole
  // transcript is fed once across the ingest turns), so do NOT multiply by
  // num_sessions here.
  const haveTokens = sample.some((i) => typeof i.est_tokens === "number");
  const ingestInputTokens = haveTokens
    ? sample.reduce((s, i) => s + (i.est_tokens || 0), 0) * nArms * seeds
    : null;

  const notes = [
    `Ingest turns run on the cheap model (${INGEST_MODEL}); probes on ${PROBE_MODEL}.`,
    `All turns multiply by seeds=${seeds}; judgeCalls = probeTurns * votes(${votes}).`,
    `Every arm (control, cortext, ...) runs all ingest + probe turns.`,
    haveTokens
      ? `Ingest input tokens are a rough estimate from sample.est_tokens.`
      : `No est_tokens on sample — token estimate omitted.`,
  ];

  return {
    ingestTurns,
    probeTurns,
    judgeCalls,
    totalAgentTurns,
    byModel,
    perArm,
    ingestInputTokens,
    notes,
  };
}

export function formatCostReport(est) {
  const lines = [];
  lines.push("=== Benchmark preflight cost estimate (counts, not $) ===");
  lines.push(`Agent turns (total): ${est.totalAgentTurns}`);
  for (const [model, turns] of Object.entries(est.byModel)) {
    const tag = model === INGEST_MODEL ? " [cheap ingest]" : "";
    lines.push(`  ${model}: ${turns} turns${tag}`);
  }
  lines.push(`Judge calls (OpenAI): ${est.judgeCalls}`);
  if (typeof est.ingestInputTokens === "number") {
    lines.push(
      `Est. ingest input tokens: ~${est.ingestInputTokens.toLocaleString()} (rough estimate)`,
    );
  }
  lines.push("Notes:");
  for (const n of est.notes) lines.push(`  - ${n}`);
  return lines.join("\n");
}
