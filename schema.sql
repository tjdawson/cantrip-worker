-- Cantrip loom schema
-- Run with: wrangler d1 execute cantrip-loom --file=schema.sql

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  entity_id TEXT NOT NULL,
  cantrip_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  utterance TEXT NOT NULL,
  observation TEXT NOT NULL,
  gate_calls TEXT NOT NULL DEFAULT '[]',
  tokens_prompt INTEGER NOT NULL DEFAULT 0,
  tokens_completion INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL,
  terminated INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  reward REAL
);

CREATE INDEX IF NOT EXISTS idx_turns_entity ON turns(entity_id);
CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_id);
CREATE INDEX IF NOT EXISTS idx_turns_cantrip ON turns(cantrip_id);
