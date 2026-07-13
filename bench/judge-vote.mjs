// Majority-vote LLM judge for LongMemEval. A single judge call is noisy: the
// grader model can flip on borderline paraphrases or occasionally hit a
// transient API error. This module reduces that noise by taking a MAJORITY VOTE
// across several INDEPENDENT judge calls. Independence is engineered two ways: (1) the sampling
// temperature is varied across votes, and (2) the grader framing is lightly
// reworded between prompt variants (same meaning, different phrasing) so each
// vote is a genuine second opinion rather than a duplicate of the first. Single
// vote calls that fail (network/HTTP) are retried once and then dropped from the
// tally instead of sinking the whole judgement; only an all-votes failure throws.
// The abstention rule (correct = the response declines / says it lacks the info /
// does not fabricate) is preserved in every prompt variant.

const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL || "gpt-5.4-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export const DEFAULT_VOTES = 3;

// Temperatures cycled across votes to decorrelate their sampling.
const TEMPERATURES = [0.0, 0.4, 0.8];

// Two phrasings of the same grading instruction, alternated across votes.
function judgePrompt(variant, questionType, question, gold, hypothesis) {
  if (questionType === "abstention") {
    if (variant === 0) {
      return `I will give you an unanswerable question (it asks about something that never happened), and a model's response. The response is correct ONLY if it declines to answer / says it has no such information / does not fabricate an answer. Reply "yes" if it correctly abstains, otherwise "no".

Question: ${question}
Model response: ${hypothesis}

Is the response a correct abstention? Answer yes or no.`;
    }
    return `Below is a question that has no valid answer because the thing it asks about never occurred, together with a model's reply. Count the reply as correct ONLY when it refuses to answer, states it lacks any such information, or otherwise avoids inventing details. Say "yes" when the model properly abstains, and "no" when it fabricates an answer.

Question: ${question}
Model reply: ${hypothesis}

Did the model correctly abstain? Answer yes or no.`;
  }
  const dateNote =
    questionType === "temporal-reasoning"
      ? " Pay attention to any temporal information: the response must be consistent with the correct answer's dates/order."
      : "";
  if (variant === 0) {
    return `I will give you a question, the correct answer, and a model's response. Decide whether the response is correct — it is correct if it conveys the same information as the correct answer (paraphrases and extra detail are fine).${dateNote} Reply "yes" if correct, otherwise "no".

Question: ${question}
Correct answer: ${gold}
Model response: ${hypothesis}

Is the model response correct? Answer yes or no.`;
  }
  return `Below are a question, the reference answer, and a model's answer. Judge the model's answer correct when it communicates the same facts as the reference answer; rewordings and additional detail do not make it wrong.${dateNote} Respond "yes" for correct and "no" for incorrect.

Question: ${question}
Reference answer: ${gold}
Model answer: ${hypothesis}

Is the model's answer correct? Answer yes or no.`;
}

async function callJudge(temperature, variant, questionType, question, gold, hypothesis) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: "You are a strict grader. Answer with a single word: yes or no." },
        { role: "user", content: judgePrompt(variant, questionType, question, gold, hypothesis) },
      ],
      temperature,
      max_completion_tokens: 4,
    }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const verdict = (j.choices?.[0]?.message?.content || "").trim().toLowerCase();
  return verdict.startsWith("y");
}

// One vote: retry once on failure, then signal a dropped vote with null.
async function oneVote(temperature, variant, questionType, question, gold, hypothesis) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callJudge(temperature, variant, questionType, question, gold, hypothesis);
    } catch (err) {
      if (attempt === 1) return null; // exhausted retry: drop this vote
    }
  }
  return null;
}

export async function voteJudge(questionType, question, gold, hypothesis, opts = {}) {
  const votes = opts.votes ?? DEFAULT_VOTES;

  // Empty responses are trivially wrong for answerable questions, but for an
  // abstention question an empty/no response is effectively a (degenerate)
  // decline; keep the single-judge behaviour of grading it via the model only
  // when there is content, otherwise short-circuit as the base judge does.
  if ((!hypothesis || !hypothesis.trim()) && questionType !== "abstention") {
    return { correct: false, yes: 0, total: votes, confidence: 0, verdicts: [] };
  }

  const calls = [];
  for (let i = 0; i < votes; i++) {
    const temperature = TEMPERATURES[i % TEMPERATURES.length];
    const variant = i % 2; // alternate between the two prompt phrasings
    calls.push(oneVote(temperature, variant, questionType, question, gold, hypothesis));
  }

  const results = await Promise.all(calls);
  const verdicts = results.filter((v) => v !== null);
  const total = verdicts.length;
  if (total === 0) throw new Error("voteJudge: all judge votes failed");

  const yes = verdicts.filter(Boolean).length;
  const correct = yes > total / 2;
  const confidence = yes / total;
  return { correct, yes, total, confidence, verdicts };
}

export { JUDGE_MODEL };
