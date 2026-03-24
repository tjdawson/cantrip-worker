/**
 * llm.ts — The LLM contract (spec Chapter 2)
 *
 * Wraps Workers AI's Kimi K2.5 behind the cantrip LLM interface:
 * messages in, structured response out.
 *
 * Model: @cf/moonshotai/kimi-k2.5
 *   - 256k context window
 *   - Native function calling (OpenAI-compatible tool_calls shape)
 *   - Thinking mode (on by default — we disable it for the agentic loop
 *     to keep latency and token cost down; enable per-cast if desired)
 *   - No external API key required — covered by the [ai] Workers binding
 *
 * LLM-1: stateless — each call is fully independent
 * LLM-6: response normalised to the common LLM contract
 * LLM-7: tool call IDs preserved exactly as returned by the model
 */

import type { GateDefinition, LLMMessage, LLMResponse, LLMToolCall } from "./types";

export const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.5";

// Kimi K2.5 via Workers AI returns an OpenAI-compatible chat completion object
interface KimiResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function queryLLM(
  ai: Ai,
  model: string,
  messages: LLMMessage[],
  gates: GateDefinition[],
  temperature = 0.6,   // Kimi recommended: 0.6 for instant/tool mode
  maxTokens = 2048,
  enableThinking = false  // disable by default for tight agentic loops
): Promise<LLMResponse> {
  // Build tools array from gate definitions (LLM-4 / CIRCLE-11)
  const tools =
    gates.length > 0
      ? gates.map((g) => ({
          type: "function" as const,
          function: {
            name: g.name,
            description: g.description,
            parameters: {
              type: "object",
              properties: g.parameters,
              required: g.required ?? Object.keys(g.parameters),
            },
          },
        }))
      : undefined;

  const params: Record<string, unknown> = {
    messages: messages as AiTextGenerationInput["messages"],
    temperature,
    max_tokens: maxTokens,
    // Kimi-specific: disable thinking for fast tool-calling loops.
    // Set enableThinking=true in Identity to get reasoning traces per turn.
    chat_template_kwargs: {
      enable_thinking: enableThinking,
    },
  };
  if (tools) {
    params.tools = tools;
    // With thinking disabled, tool_choice can be "auto" or "required"
    params.tool_choice = "auto";
  }

  const raw = await ai.run(
    model as BaseAiTextGenerationModels,
    params as AiTextGenerationInput
  ) as KimiResponse;

  const message = raw.choices?.[0]?.message;
  if (!message) {
    throw new Error("Kimi returned no choices (LLM-3 violation)");
  }

  // LLM-7: preserve tool call IDs and ordering exactly as returned
  const tool_calls: LLMToolCall[] = (message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments, // already a JSON string
    },
  }));

  // LLM-3: must return at least one of content or tool_calls
  const content = message.content ?? null;
  if (content === null && tool_calls.length === 0) {
    throw new Error("Kimi returned neither content nor tool calls (LLM-3 violation)");
  }

  return {
    content,
    tool_calls,
    usage: {
      prompt_tokens: raw.usage?.prompt_tokens ?? 0,
      completion_tokens: raw.usage?.completion_tokens ?? 0,
    },
  };
}
