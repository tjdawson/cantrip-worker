/**
 * entity.ts — The CantripEntity Durable Object (spec Chapters 1, 3, 4)
 *
 * This is where the loop lives. One Durable Object instance = one Entity.
 * The DO is addressed by entity_id, so every cast to the same entity_id
 * lands on the same instance with accumulated state.
 *
 * Key spec rules enforced here:
 *
 * LOOP-1:  strict alternation — entity utterance, then circle observation
 * LOOP-2:  loop MUST terminate — done gate + ward max_turns
 * LOOP-3:  done gate stops the loop immediately
 * LOOP-4:  ward truncation stops the loop, records truncated=true
 * LOOP-6:  text-only response = implicit termination (require_done_tool=false default)
 * ENTITY-2: unique entity ID
 * ENTITY-3: state grows monotonically
 * ENTITY-5: summoned entity persists, accepts additional intents
 * IDENTITY-1/2: system prompt fixed, present on every query
 * CIRCLE-1: done gate always present
 * CIRCLE-2: max_turns ward always present
 * CIRCLE-3: gate execution synchronous from entity's perspective
 * CIRCLE-7: multiple gate calls in one utterance → execute in order, one composite observation
 * LOOM-1:  turn recorded before next begins
 */

import { DurableObject } from "cloudflare:workers";
import { queryLLM, DEFAULT_MODEL } from "./llm";
import { executeGate, formatObservation, DONE_GATE, FETCH_URL_GATE, THINK_GATE } from "./gates";
import { Loom } from "./loom";
import type {
  EntityState,
  Identity,
  CircleConfig,
  LLMMessage,
  GateCallRecord,
  CastRequest,
  CastResponse,
} from "./types";

// ─── Env interface ────────────────────────────────────────────────────────────

export interface Env {
  CANTRIP_ENTITY: DurableObjectNamespace<CantripEntity>;
  LOOM_DB: D1Database;
  AI: Ai;
  MAX_TURNS_DEFAULT: string;
  API_SECRET: string;      // set via: wrangler secret put API_SECRET
  ALLOWED_ORIGIN: string;  // set in wrangler.toml [vars], e.g. "https://yourdomain.com"
}

// ─── Default configuration ────────────────────────────────────────────────────

const DEFAULT_IDENTITY: Identity = {
  systemPrompt:
    "You are a helpful assistant operating in a tool-calling loop. " +
    "Use the available tools to accomplish the task. " +
    "When you have a final answer, call the `done` tool with your result. " +
    "Think step by step. If a tool call fails, adapt and try a different approach.",
  model: DEFAULT_MODEL,
  temperature: 0.7,
  maxTokens: 1024,
};

const DEFAULT_CIRCLE: CircleConfig = {
  gates: [DONE_GATE, FETCH_URL_GATE, THINK_GATE],
  wards: { maxTurns: 20, requireDoneTool: false },
};

// ─── CantripEntity Durable Object ─────────────────────────────────────────────

export class CantripEntity extends DurableObject<Env> {
  private loom!: Loom;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loom = new Loom(env.LOOM_DB);
  }

  // ─── RPC: cast an intent ──────────────────────────────────────────────────
  // ENTITY-5: a summoned entity may receive additional intents as new casts

  async cast(req: CastRequest): Promise<CastResponse> {
    // Guard: bound intent size to prevent oversized context attacks
    if (!req.intent || req.intent.length === 0) {
      throw new Error("intent is required");
    }
    if (req.intent.length > 10_000) {
      throw new Error("Intent exceeds maximum length of 10,000 characters");
    }

    // Load or initialise entity state from DO storage
    let state = await this.loadState();
    if (!state) {
      state = initState(req);
    }

    // Merge any per-cast identity/circle overrides
    const identity: Identity = { ...DEFAULT_IDENTITY, ...state.identity, ...(req.identity ?? {}) };
    const circle: CircleConfig = mergeCircle(state.circle, req.circle);

    // INTENT-2: intent is the first user message (after system prompt)
    // INTENT-3: intent is immutable — append as a new user message
    state.messages.push({ role: "user", content: req.intent });

    await this.saveState(state);

    // ── The Loop ─────────────────────────────────────────────────────────────
    const maxTurns = circle.wards.maxTurns ?? 20;
    let turnCount = 0;
    let terminated = false;
    let truncated = false;
    let truncationReason: string | undefined;
    let finalResult: string | null = null;
    let lastTurnId: string | null = null;

    while (!terminated && !truncated) {
      // CIRCLE-2 / WARD: enforce max turns
      if (turnCount >= maxTurns) {
        truncated = true;
        truncationReason = `max_turns (${maxTurns}) reached`;
        break;
      }

      const turnStart = Date.now();

      // Query the LLM (LLM-1: stateless, gets full message history each time)
      let llmResponse;
      try {
        llmResponse = await queryLLM(
          this.env.AI,
          identity.model ?? DEFAULT_MODEL,
          buildMessages(identity, state.messages),
          circle.gates,
          identity.temperature,
          identity.maxTokens,
          identity.enableThinking ?? false
        );
      } catch (err) {
        // LLM errors are fatal for this turn — record and truncate
        truncated = true;
        truncationReason = `LLM error: ${err}`;
        break;
      }

      const turnDurationMs = Date.now() - turnStart;
      turnCount++;
      state.turn_count++;

      // Record utterance: assistant message with content and/or tool_calls
      const assistantMsg: LLMMessage = {
        role: "assistant",
        content: llmResponse.content,
        tool_calls: llmResponse.tool_calls.length > 0 ? llmResponse.tool_calls : undefined,
      };
      state.messages.push(assistantMsg);

      // Serialise utterance for loom
      const utterance = JSON.stringify({
        content: llmResponse.content,
        tool_calls: llmResponse.tool_calls,
      });

      // ── LOOP-6: text-only response = implicit termination ─────────────────
      if (llmResponse.tool_calls.length === 0 && !circle.wards.requireDoneTool) {
        finalResult = llmResponse.content ?? "";
        terminated = true;

        const turnId = crypto.randomUUID();
        await this.loom.appendTurn({
          id: turnId,
          parent_id: lastTurnId,
          entity_id: state.entity_id,
          cantrip_id: state.cantrip_id,
          sequence: state.turn_count,
          utterance,
          observation: "(implicit termination — text-only response)",
          gate_calls: [],
          tokens_prompt: llmResponse.usage.prompt_tokens,
          tokens_completion: llmResponse.usage.completion_tokens,
          duration_ms: turnDurationMs,
          timestamp: new Date().toISOString(),
          terminated: true,
          truncated: false,
          reward: null,
        });
        lastTurnId = turnId;
        break;
      }

      // ── Execute gate calls (CIRCLE-3, CIRCLE-7) ───────────────────────────
      const gateRecords: GateCallRecord[] = [];
      const toolResultMessages: LLMMessage[] = [];

      for (const toolCall of llmResponse.tool_calls) {
        const gateResult = await executeGate(
          toolCall.function.name,
          toolCall.function.arguments
        );

        gateRecords.push(gateResult.record);

        // CIRCLE-4: gate results go back to entity as tool messages
        toolResultMessages.push({
          role: "tool",
          content: gateResult.record.result,
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
        });

        // LOOP-3: done gate stops the loop after processing
        if (gateResult.kind === "done") {
          finalResult = gateResult.result;
          terminated = true;
          break; // LOOP-3: skip remaining gate calls in same utterance
        }
      }

      // Build composite observation (CIRCLE-7: one object per turn)
      const observation = formatObservation(gateRecords);

      // Add tool result messages to history (LLM-7: preserve call-result linkage)
      state.messages.push(...toolResultMessages);

      // LOOM-1: record turn before next begins
      const turnId = crypto.randomUUID();
      await this.loom.appendTurn({
        id: turnId,
        parent_id: lastTurnId,
        entity_id: state.entity_id,
        cantrip_id: state.cantrip_id,
        sequence: state.turn_count,
        utterance,
        observation,
        gate_calls: gateRecords,
        tokens_prompt: llmResponse.usage.prompt_tokens,
        tokens_completion: llmResponse.usage.completion_tokens,
        duration_ms: turnDurationMs,
        timestamp: new Date().toISOString(),
        terminated,
        truncated: false,
        reward: null,
      });
      lastTurnId = turnId;

      await this.saveState(state);

      if (terminated) break;
    }

    // If we exited by truncation, record the truncated terminal turn
    if (truncated && lastTurnId !== null) {
      // Update the last turn to mark truncated
      // (We can't mutate D1 rows per LOOM-3 except for reward,
      //  so we append a sentinel truncation record instead)
      const truncTurnId = crypto.randomUUID();
      await this.loom.appendTurn({
        id: truncTurnId,
        parent_id: lastTurnId,
        entity_id: state.entity_id,
        cantrip_id: state.cantrip_id,
        sequence: state.turn_count + 1,
        utterance: "(truncated)",
        observation: truncationReason ?? "ward triggered",
        gate_calls: [],
        tokens_prompt: 0,
        tokens_completion: 0,
        duration_ms: 0,
        timestamp: new Date().toISOString(),
        terminated: false,
        truncated: true,
        reward: null,
      });
    }

    await this.saveState(state);

    return {
      entity_id: state.entity_id,
      cantrip_id: state.cantrip_id,
      result: finalResult,
      turns: turnCount,
      terminated,
      truncated,
      truncation_reason: truncationReason,
    };
  }

  // ─── RPC: get loom thread for this entity ─────────────────────────────────

  async getThread(): Promise<unknown[]> {
    const state = await this.loadState();
    if (!state) return [];
    return this.loom.getEntityThread(state.entity_id);
  }

  // ─── RPC: get entity state ────────────────────────────────────────────────

  async getState(): Promise<EntityState | null> {
    return this.loadState();
  }

  // ─── Storage helpers ──────────────────────────────────────────────────────

  private async loadState(): Promise<EntityState | null> {
    return (await this.ctx.storage.get<EntityState>("state")) ?? null;
  }

  private async saveState(state: EntityState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initState(req: CastRequest): EntityState {
  const entityId = crypto.randomUUID();
  const cantripId = req.cantrip_id ?? crypto.randomUUID();

  return {
    entity_id: entityId,
    cantrip_id: cantripId,
    identity: { ...DEFAULT_IDENTITY, ...(req.identity ?? {}) },
    circle: mergeCircle(DEFAULT_CIRCLE, req.circle),
    messages: [],
    turn_count: 0,
    created_at: new Date().toISOString(),
  };
}

function mergeCircle(base: CircleConfig, override?: Partial<CircleConfig>): CircleConfig {
  if (!override) return base;
  return {
    gates: override.gates ?? base.gates,
    wards: {
      // WARD-1: min() for numeric wards; floor at 1 to prevent zero-turn loops
      maxTurns: Math.max(1, Math.min(
        base.wards.maxTurns ?? 20,
        override.wards?.maxTurns ?? 20
      )),
      // WARD-1: OR for boolean wards
      requireDoneTool:
        (base.wards.requireDoneTool ?? false) || (override.wards?.requireDoneTool ?? false),
    },
  };
}

// Build the message list the LLM sees on each query.
// Three layers (§4.6): identity (system) → history → (no intent injection needed,
// intent was pushed as first user message when cast was called)
function buildMessages(identity: Identity, history: LLMMessage[]): LLMMessage[] {
  const messages: LLMMessage[] = [];

  // IDENTITY-2: system prompt first, every time, unchanged
  if (identity.systemPrompt) {
    messages.push({ role: "system", content: identity.systemPrompt });
  }

  messages.push(...history);
  return messages;
}
