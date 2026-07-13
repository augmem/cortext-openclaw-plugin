/**
 * Local mirror of the OpenClaw plugin SDK surface this plugin uses.
 *
 * Transcribed from the INSTALLED `openclaw` package's type declarations
 * (dist/types-*.d.ts, dist/hook-types-*.d.ts). The event subscription lives at
 * `api.agent.events.registerAgentEventSubscription`, NOT the `api.runtime.events
 * .onAgentEvent` the docs imply (that does not exist and crashed an earlier
 * build). `api.on` and `api.resolvePath` DO exist. The shapes below are what the
 * gateway injects at runtime; the test double in tests/helpers.mjs mirrors this
 * exactly so an unsupported call cannot pass tests.
 */

export interface Logger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** OpenClaw message. UserMessage.content may be a string or a block array. */
export interface AgentMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

// --- Context engine (dist: ContextEngine, ContextEngineFactoryContext) ------

export interface ContextEngineInfo {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
  turnMaintenanceMode?: "foreground" | "background";
}

export interface IngestParams {
  sessionId: string;
  sessionKey?: string;
  message: AgentMessage;
  isHeartbeat?: boolean;
}
export interface IngestResult {
  ingested: boolean;
}

export interface AssembleParams {
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  tokenBudget?: number;
  availableTools?: Set<string>;
  citationsMode?: string;
  model?: string;
  prompt?: string;
}
export interface AssembleResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  promptAuthority?: "assembled" | "preassembly_may_overflow";
  systemPromptAddition?: string;
}

export interface CompactParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  tokenBudget?: number;
  force?: boolean;
  currentTokenCount?: number;
  abortSignal?: AbortSignal;
}
export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  /** Extended shape the host reads when present (embedded-agent runner):
   *  summary/tokensBefore/tokensAfter feed the compaction checkpoint. */
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore?: number;
    tokensAfter?: number;
  };
}

export interface ContextEngine {
  readonly info: ContextEngineInfo;
  ingest(params: IngestParams): Promise<IngestResult>;
  assemble(params: AssembleParams): Promise<AssembleResult>;
  compact(params: CompactParams): Promise<CompactResult>;
  dispose?(): Promise<void>;
}

export interface ContextEngineFactoryContext {
  config?: Record<string, unknown>;
  agentDir?: string;
  workspaceDir?: string;
}
export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;

// --- Agent event subscription (dist: OpenClawPluginAgentEventsApi) ----------

export type AgentEventStream =
  | "lifecycle"
  | "assistant"
  | "thinking"
  | "tool"
  | "error"
  | (string & {});

/** Payload delivered to an agent-event subscription handler. */
export interface AgentEventPayload {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  /** Incremental text is `data.delta`; snapshot is `data.text`; lifecycle phase is `data.phase`. */
  data: Record<string, unknown>;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}

export interface AgentEventSubscriptionCtx {
  getRunContext<T = unknown>(namespace: string): T | undefined;
  setRunContext(namespace: string, value: unknown): void;
  clearRunContext(namespace?: string): void;
}

export interface AgentEventSubscription {
  id: string;
  description?: string;
  streams?: AgentEventStream[];
  handle(event: AgentEventPayload, ctx: AgentEventSubscriptionCtx): void | Promise<void>;
}

export interface OpenClawPluginAgentApi {
  events: {
    registerAgentEventSubscription(subscription: AgentEventSubscription): void;
  };
}

// --- Services (dist: OpenClawPluginService) ---------------------------------

export interface Service {
  id: string;
  start(ctx: Record<string, unknown>): void | Promise<void>;
  stop?(ctx: Record<string, unknown>): void | Promise<void>;
}

// --- Plugin api + entry -----------------------------------------------------

// --- Typed lifecycle hook: before_agent_finalize (dist: hook-types) ---------

export interface BeforeAgentFinalizeEvent {
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  lastAssistantMessage?: string;
  [key: string]: unknown;
}

export type BeforeAgentFinalizeResult =
  | { action: "revise"; reason?: string; retry?: { instruction: string; idempotencyKey?: string; maxAttempts?: number } }
  | { action: "finalize"; reason?: string }
  | { action: "continue" }
  | void;

export interface OpenClawPluginApi {
  id: string;
  pluginConfig?: Record<string, unknown>;
  config: Record<string, unknown>;
  logger: Logger;
  agent: OpenClawPluginAgentApi;
  resolvePath(input: string): string;
  registerContextEngine(id: string, factory: ContextEngineFactory): void;
  registerService(service: Service): void;
  registerHook(
    events: string | string[],
    handler: (event: unknown) => void | Promise<void>,
    opts?: Record<string, unknown>,
  ): void;
  on(
    event: "before_agent_finalize",
    handler: (event: BeforeAgentFinalizeEvent) => BeforeAgentFinalizeResult | Promise<BeforeAgentFinalizeResult>,
  ): void;
}
