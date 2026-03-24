/**
 * gates.ts — Gate definitions and executor (spec Chapter 4)
 *
 * Gates are the crossing points through the circle's boundary.
 * This module defines:
 *   - The mandatory `done` gate (CIRCLE-1, CIRCLE-8)
 *   - A `fetch_url` gate (example real-world gate)
 *   - The gate executor that runs gate calls and returns GateCallRecords
 *
 * CIRCLE-5: errors are returned as observations, never swallowed.
 * CIRCLE-3: execution is synchronous from the entity's perspective.
 */

import type { GateCallRecord, GateDefinition } from "./types";

// ─── Built-in gate definitions ────────────────────────────────────────────────

export const DONE_GATE: GateDefinition = {
  name: "done",
  description:
    "Signal task completion. Call this when you have a final answer. The loop will stop.",
  parameters: {
    result: {
      type: "string",
      description: "Your final answer or result.",
    },
  },
  required: ["result"],
};

export const FETCH_URL_GATE: GateDefinition = {
  name: "fetch_url",
  description: "Fetch the text content of a public URL.",
  parameters: {
    url: { type: "string", description: "The URL to fetch." },
  },
  required: ["url"],
};

export const THINK_GATE: GateDefinition = {
  name: "think",
  description:
    "Record a private reasoning step. Use this to think out loud before acting. The thought is recorded but does not produce output.",
  parameters: {
    thought: { type: "string", description: "Your reasoning." },
  },
  required: ["thought"],
};

// ─── Gate executor ────────────────────────────────────────────────────────────

// Result type from executing a gate call — may be a special signal
export type GateResult =
  | { kind: "observation"; record: GateCallRecord }
  | { kind: "done"; result: string; record: GateCallRecord };

export async function executeGate(
  gateName: string,
  rawArgs: string
): Promise<GateResult> {
  const startMs = Date.now();

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    const record: GateCallRecord = {
      gate_name: gateName,
      arguments: rawArgs,
      result: "Invalid JSON arguments",
      is_error: true,
    };
    return { kind: "observation", record };
  }

  // done gate — LOOP-3: loop MUST stop after processing done
  if (gateName === "done") {
    const result = String(args.result ?? "");
    const record: GateCallRecord = {
      gate_name: "done",
      arguments: rawArgs,
      result,
      is_error: false,
    };
    return { kind: "done", result, record };
  }

  // think gate — just echoes back, no side effect
  if (gateName === "think") {
    const record: GateCallRecord = {
      gate_name: "think",
      arguments: rawArgs,
      result: "Thought recorded.",
      is_error: false,
    };
    return { kind: "observation", record };
  }

  // fetch_url gate
  if (gateName === "fetch_url") {
    const rawUrl = String(args.url ?? "");
    try {
      // Validate URL is well-formed
      const parsed = new URL(rawUrl);

      // Only allow http and https — block file://, ftp://, etc.
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`Protocol '${parsed.protocol}' is not permitted — use http or https`);
      }

      // Block SSRF targets: private IPs, localhost, link-local, metadata endpoints
      const hostname = parsed.hostname.toLowerCase();
      const blockedPatterns = [
        /^localhost$/,
        /^127\./,
        /^0\./,
        /^10\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^192\.168\./,
        /^169\.254\./,   // link-local / AWS metadata
        /^::1$/,         // IPv6 loopback
        /^fc00:/,        // IPv6 private
        /^fe80:/,        // IPv6 link-local
      ];
      if (blockedPatterns.some((p) => p.test(hostname))) {
        throw new Error(`Requests to '${hostname}' are not permitted`);
      }

      const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Cap body read at 1MB before decoding — prevents buffering huge responses
      const MAX_BYTES = 1_048_576;
      const buffer = await resp.arrayBuffer();
      const sliced = buffer.byteLength > MAX_BYTES ? buffer.slice(0, MAX_BYTES) : buffer;
      const text = new TextDecoder().decode(sliced);
      const wasTruncated = buffer.byteLength > MAX_BYTES;
      // Viewport principle (§4.6): return a preview, not the full body
      const preview = text.slice(0, 2000);
      const totalNote = wasTruncated
        ? `${buffer.byteLength} bytes (truncated to 1MB)`
        : `${buffer.byteLength} bytes`;
      const summary = `[${totalNote}] ${preview}${text.length > 2000 ? "…" : ""}`;
      const record: GateCallRecord = {
        gate_name: "fetch_url",
        arguments: rawArgs,
        result: summary,
        is_error: false,
      };
      return { kind: "observation", record };
    } catch (err) {
      // CIRCLE-5: errors are observations
      const record: GateCallRecord = {
        gate_name: "fetch_url",
        arguments: rawArgs,
        result: String(err),
        is_error: true,
      };
      return { kind: "observation", record };
    }
  }

  // Unknown gate
  const record: GateCallRecord = {
    gate_name: gateName,
    arguments: rawArgs,
    result: `Unknown gate: ${gateName}`,
    is_error: true,
  };
  return { kind: "observation", record };
}

// Format a list of GateCallRecords into a single observation string
// for inclusion in the next user message (CIRCLE-4, CIRCLE-7)
export function formatObservation(records: GateCallRecord[]): string {
  return records
    .map((r) => {
      const status = r.is_error ? "ERROR" : "OK";
      return `[gate:${r.gate_name}] [${status}]\nargs: ${r.arguments}\nresult: ${r.result}`;
    })
    .join("\n\n");
}
