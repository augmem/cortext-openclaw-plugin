// LLM judge for LongMemEval, following the benchmark's autoeval approach: an
// LLM decides whether a model response is correct given the question and the
// gold answer. Abstention questions are correct when the model declines.
// Uses the OpenAI API directly (separate from the OpenClaw agent under test).

const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL || "gpt-5.4-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Prompt templates adapted from the LongMemEval autoeval prompts (per question
// type), condensed to a single correctness decision returning "yes"/"no".
function judgePrompt(questionType, question, gold, hypothesis) {
  if (questionType === "abstention") {
    return `I will give you an unanswerable question (it asks about something that never happened), and a model's response. The response is correct ONLY if it declines to answer / says it has no such information / does not fabricate an answer. Reply "yes" if it correctly abstains, otherwise "no".

Question: ${question}
Model response: ${hypothesis}

Is the response a correct abstention? Answer yes or no.`;
  }
  const dateNote =
    questionType === "temporal-reasoning"
      ? " Pay attention to any temporal information: the response must be consistent with the correct answer's dates/order."
      : "";
  return `I will give you a question, the correct answer, and a model's response. Decide whether the response is correct — it is correct if it conveys the same information as the correct answer (paraphrases and extra detail are fine).${dateNote} Reply "yes" if correct, otherwise "no".

Question: ${question}
Correct answer: ${gold}
Model response: ${hypothesis}

Is the model response correct? Answer yes or no.`;
}

export async function judge(questionType, question, gold, hypothesis) {
  if (!hypothesis || !hypothesis.trim()) return false;
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: "You are a strict grader. Answer with a single word: yes or no." },
        { role: "user", content: judgePrompt(questionType, question, gold, hypothesis) },
      ],
      max_completion_tokens: 4,
    }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const verdict = (j.choices?.[0]?.message?.content || "").trim().toLowerCase();
  return verdict.startsWith("y");
}

export { JUDGE_MODEL };
