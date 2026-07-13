// Frozen scenario for the OpenClaw memory comparison. Neutral facts (no secrets
// that trip model refusals). Each fact is stated once in a "store" session; each
// probe runs in a FRESH session so recall must come from durable memory, not
// chat history.
export const FACTS = [
  "My deploy pipeline is named Bluefin and it runs every 30 days.",
  "My primary datacenter is located in Reykjavik.",
  "Our on-call rotation lead this quarter is Priya.",
  "The staging database is Postgres version 16.",
  "My API rate limit is 4200 requests per minute.",
  // supersession pair: the appointment moves; the old day must not resurface.
  "My dentist appointment is on Tuesday.",
  "Actually, my dentist appointment moved to Thursday.",
];

export const PROBES = [
  { id: "pipeline", q: "What is my deploy pipeline named and how often does it run?", want: [/bluefin/i, /\b30\b/], stale: [] },
  { id: "datacenter", q: "Where is my primary datacenter located?", want: [/reykjavik/i], stale: [] },
  { id: "oncall", q: "Who is our on-call rotation lead this quarter?", want: [/priya/i], stale: [] },
  { id: "db-version", q: "What version is the staging database?", want: [/\b16\b/], stale: [] },
  { id: "rate-limit", q: "What is my API rate limit?", want: [/4[,\s]?200/], stale: [] },
  { id: "supersession", q: "When is my dentist appointment?", want: [/thursday/i], stale: [/tuesday/i] },
];
