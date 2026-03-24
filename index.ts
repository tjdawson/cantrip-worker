/**
 * index.ts — Worker entry point + HTTP router
 *
 * Routes:
 *   POST /cast                — cast an intent, get a result
 *   POST /entity/:id/cast     — cast to a specific (persistent) entity
 *   GET  /entity/:id/thread   — retrieve the loom thread for an entity
 *   GET  /entity/:id/state    — retrieve entity state
 *   GET  /health              — healthcheck (unauthenticated, safe)
 *
 * Authentication:
 *   All routes except /health require:
 *     Authorization: Bearer <API_SECRET>
 *   Set via: wrangler secret put API_SECRET
 *
 * Entity addressing (ENTITY-2):
 *   - POST /cast with no entity_id → new entity each time (cast semantics)
 *   - POST /entity/:id/cast        → same entity across calls (summon semantics)
 */

import { CantripEntity } from "./entity";
import type { Env } from "./entity";
import type { CastRequest } from "./types";

export { CantripEntity };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── CORS preflight ────────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    // ── Health check — unauthenticated, reveals nothing sensitive ─────────────
    if (request.method === "GET" && path === "/health") {
      return jsonResponse({ status: "ok" }, 200, env);
    }

    // ── Authentication — all other routes require a valid Bearer token ────────
    if (!isAuthenticated(request, env)) {
      // Use 401 with a fixed-length response to avoid timing attacks
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="cantrip"' },
      });
    }

    try {
      // ── POST /cast — one-shot cast (new entity per call) ───────────────────
      if (request.method === "POST" && path === "/cast") {
        const body = await request.json<CastRequest>();
        if (!body.intent) {
          return jsonError("intent is required", 400, env);
        }

        // Fresh entity for each one-shot cast (CANTRIP-2)
        const entityId = crypto.randomUUID();
        const stub = getEntityStub(env, entityId);
        const result = await stub.cast(body);
        return jsonResponse(result, 200, env);
      }

      // ── POST /entity/:id/cast — cast to a persistent entity ───────────────
      const castMatch = path.match(/^\/entity\/([^/]+)\/cast$/);
      if (request.method === "POST" && castMatch) {
        const entityId = castMatch[1];
        const body = await request.json<CastRequest>();
        if (!body.intent) {
          return jsonError("intent is required", 400, env);
        }

        const stub = getEntityStub(env, entityId);
        const result = await stub.cast(body);
        return jsonResponse(result, 200, env);
      }

      // ── GET /entity/:id/thread — retrieve loom thread ─────────────────────
      const threadMatch = path.match(/^\/entity\/([^/]+)\/thread$/);
      if (request.method === "GET" && threadMatch) {
        const entityId = threadMatch[1];
        const stub = getEntityStub(env, entityId);
        const thread = await stub.getThread();
        return jsonResponse({ entity_id: entityId, thread }, 200, env);
      }

      // ── GET /entity/:id/state — retrieve entity state ─────────────────────
      const stateMatch = path.match(/^\/entity\/([^/]+)\/state$/);
      if (request.method === "GET" && stateMatch) {
        const entityId = stateMatch[1];
        const stub = getEntityStub(env, entityId);
        const state = await stub.getState();
        if (!state) return jsonError("Entity not found", 404, env);
        // Omit message history from state response (potentially large)
        const { messages: _, ...safeState } = state;
        return jsonResponse(safeState, 200, env);
      }

      return jsonError("Not found", 404, env);
    } catch (err) {
      // Log full error server-side only — never expose internals to the caller
      console.error("Worker error:", err);
      return jsonError("Internal server error", 500, env);
    }
  },
} satisfies ExportedHandler<Env>;

// ─── Authentication ───────────────────────────────────────────────────────────

function isAuthenticated(request: Request, env: Env): boolean {
  const apiSecret = env.API_SECRET;
  // If no secret is configured, deny all requests (fail closed, not open)
  if (!apiSecret) return false;
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  // Fully constant-time comparison — no early exit on length mismatch,
  // which would leak the secret length as a timing oracle.
  const len = Math.max(token.length, apiSecret.length);
  let mismatch = token.length !== apiSecret.length ? 1 : 0;
  for (let i = 0; i < len; i++) {
    mismatch |= (token.charCodeAt(i) || 0) ^ (apiSecret.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getEntityStub(env: Env, entityId: string): DurableObjectStub<CantripEntity> {
  const id = env.CANTRIP_ENTITY.idFromName(entityId);
  return env.CANTRIP_ENTITY.get(id);
}

function jsonResponse(data: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function jsonError(message: string, status: number, env: Env): Response {
  return jsonResponse({ error: message }, status, env);
}

function corsHeaders(env: Env): Record<string, string> {
  // Lock CORS to a configured origin; fall back to same-origin (no wildcard)
  const origin = env.ALLOWED_ORIGIN ?? "";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
