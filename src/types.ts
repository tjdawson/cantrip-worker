// ─── Cantrip Types ────────────────────────────────────────────────────────────
// Mapping spec vocabulary to TypeScript interfaces.

export interface Identity {
  systemPrompt: string;
  model?: string;         // defaults to "@cf/moonshotai/kimi-k2.5"
  enableThinking?: boolean; // Kimi thinking mode — default false for fast tool loops
  temperature?: number;
  maxTokens?: number;
}

export interface GateDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema properties
  required?: string[];
}

export interface Ward {
  maxTurns?: number;
  requireDoneTool?: boolean;
}

export interface CircleConfig {
  gates: GateDefinition[]; // tool-calling circle — the mandatory conformance tier
  wards: Ward;
}

// What gets stored per gate call within a turn
export interface GateCallRecord {
  gate_name: string;
  arguments: string; // JSON-encoded
  result: string;    // JSON-encoded return value or error message
  is_error: boolean;
}

// A single turn node in the loom tree
export interface Turn {
  id: string;
  parent_id: string | null;
  entity_id: string;
  cantrip_id: string;
  sequence: number;
  utterance: string;         // what the entity said / its tool calls serialized
  observation: string;       // composite observation returned to entity
  gate_calls: GateCallRecord[];
  tokens_prompt: number;
  tokens_completion: number;
  duration_ms: number;
  timestamp: string;
  terminated: boolean;
  truncated: boolean;
  reward: number | null;
}

// ─── LLM message shapes (OpenAI-compatible, which CF Workers AI uses) ─────────

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;  // for role=tool
  name?: string;
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LLMResponse {
  content: string | null;
  tool_calls: LLMToolCall[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

// ─── Cast request/response ────────────────────────────────────────────────────

export interface CastRequest {
  intent: string;
  cantrip_id?: string;
  identity?: Partial<Identity>;
  circle?: Partial<CircleConfig>;
}

export interface CastResponse {
  entity_id: string;
  cantrip_id: string;
  result: string | null;
  turns: number;
  terminated: boolean;
  truncated: boolean;
  truncation_reason?: string;
}

// ─── Entity state (stored in Durable Object) ──────────────────────────────────

export interface EntityState {
  entity_id: string;
  cantrip_id: string;
  identity: Identity;
  circle: CircleConfig;
  messages: LLMMessage[];   // full conversation history
  turn_count: number;
  created_at: string;
}
