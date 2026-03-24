/**
 * loom.ts — The Loom (spec Chapter 6)
 *
 * Append-only tree of every turn across all entity runs.
 * Backed by D1 (SQLite at the edge).
 *
 * LOOM-1: every turn recorded before the next begins
 * LOOM-2: unique ID + parent reference
 * LOOM-3: append-only — turns never deleted or modified (reward is the one exception)
 * LOOM-7: records terminated vs truncated
 * LOOM-9: records token usage + duration
 * LOOM-10: supports extracting any root-to-leaf path as a thread
 */

import type { Turn, GateCallRecord } from "./types";

export class Loom {
  constructor(private db: D1Database) {}

  // ─── Write ─────────────────────────────────────────────────────────────────

  async appendTurn(turn: Turn): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO turns
          (id, parent_id, entity_id, cantrip_id, sequence,
           utterance, observation, gate_calls,
           tokens_prompt, tokens_completion, duration_ms, timestamp,
           terminated, truncated, reward)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        turn.id,
        turn.parent_id,
        turn.entity_id,
        turn.cantrip_id,
        turn.sequence,
        turn.utterance,
        turn.observation,
        JSON.stringify(turn.gate_calls),
        turn.tokens_prompt,
        turn.tokens_completion,
        turn.duration_ms,
        turn.timestamp,
        turn.terminated ? 1 : 0,
        turn.truncated ? 1 : 0,
        turn.reward
      )
      .run();
  }

  // LOOM-3 exception: reward MAY be assigned/updated after creation
  async setReward(turnId: string, reward: number): Promise<void> {
    await this.db
      .prepare(`UPDATE turns SET reward = ? WHERE id = ?`)
      .bind(reward, turnId)
      .run();
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async getTurn(id: string): Promise<Turn | null> {
    const row = await this.db
      .prepare(`SELECT * FROM turns WHERE id = ?`)
      .bind(id)
      .first();
    return row ? rowToTurn(row) : null;
  }

  // Get all turns for an entity, ordered by sequence
  async getEntityThread(entityId: string): Promise<Turn[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM turns WHERE entity_id = ? ORDER BY sequence ASC`)
      .bind(entityId)
      .all();
    return results.map(rowToTurn);
  }

  // LOOM-10: extract any root-to-leaf path by walking parent_id links
  async getThread(leafTurnId: string): Promise<Turn[]> {
    const thread: Turn[] = [];
    let currentId: string | null = leafTurnId;
    const MAX_DEPTH = 1000; // guard against cycles or pathologically deep trees
    let depth = 0;

    while (currentId && depth < MAX_DEPTH) {
      depth++;
      const turn = await this.getTurn(currentId);
      if (!turn) break;
      thread.unshift(turn); // prepend — we're walking leaf -> root
      currentId = turn.parent_id;
    }

    return thread;
  }

  // Get all child turns spawned from a given parent turn (for composition)
  async getChildTurns(parentTurnId: string): Promise<Turn[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM turns WHERE parent_id = ? ORDER BY sequence ASC`)
      .bind(parentTurnId)
      .all();
    return results.map(rowToTurn);
  }

  // Summary stats for an entity's run
  async getEntityStats(entityId: string): Promise<{
    turn_count: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    terminated: boolean;
    truncated: boolean;
  }> {
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) as turn_count,
           SUM(tokens_prompt) as total_prompt_tokens,
           SUM(tokens_completion) as total_completion_tokens,
           MAX(terminated) as terminated,
           MAX(truncated) as truncated
         FROM turns WHERE entity_id = ?`
      )
      .bind(entityId)
      .first();

    return {
      turn_count: Number(row?.turn_count ?? 0),
      total_prompt_tokens: Number(row?.total_prompt_tokens ?? 0),
      total_completion_tokens: Number(row?.total_completion_tokens ?? 0),
      terminated: Boolean(row?.terminated),
      truncated: Boolean(row?.truncated),
    };
  }

  // List all entities for a cantrip (useful for comparative RL — §6.4)
  async getCantripEntities(cantripId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(`SELECT DISTINCT entity_id FROM turns WHERE cantrip_id = ?`)
      .bind(cantripId)
      .all();
    return results.map((r) => String(r.entity_id));
  }
}

// ─── Row deserialiser ─────────────────────────────────────────────────────────

function rowToTurn(row: Record<string, unknown>): Turn {
  let gate_calls: GateCallRecord[] = [];
  try {
    gate_calls = JSON.parse(String(row.gate_calls ?? "[]"));
  } catch {
    gate_calls = [];
  }
  return {
    id: String(row.id),
    parent_id: row.parent_id ? String(row.parent_id) : null,
    entity_id: String(row.entity_id),
    cantrip_id: String(row.cantrip_id),
    sequence: Number(row.sequence),
    utterance: String(row.utterance),
    observation: String(row.observation),
    gate_calls,
    tokens_prompt: Number(row.tokens_prompt),
    tokens_completion: Number(row.tokens_completion),
    duration_ms: Number(row.duration_ms),
    timestamp: String(row.timestamp),
    terminated: Boolean(row.terminated),
    truncated: Boolean(row.truncated),
    reward: row.reward != null ? Number(row.reward) : null,
  };
}
