# cantrip-worker

A Cloudflare Workers implementation of the [Cantrip spec](https://www.deepfates.com/cantrip) —
a framework for agentic LLM entities running in a tool-calling loop.

## Architecture

```
HTTP Request
    │
    ▼
Worker (index.ts)          — stateless router, one per request
    │
    ├─ idFromName(entityId)
    ▼
CantripEntity (entity.ts)  — Durable Object, one per entity
    │                         holds message history, runs the loop
    ├─ queryLLM()           — Workers AI (llm.ts)
    ├─ executeGate()        — gate execution (gates.ts)
    └─ loom.appendTurn()    — D1 append-only tree (loom.ts)
                              database: cantrip-loom
```

### Spec mapping

| Cantrip concept | This implementation          |
|-----------------|------------------------------|
| LLM             | Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| Identity        | Stored in DO storage, fixed at first cast |
| Circle          | Tool-calling circle (mandatory tier) |
| Gates           | `done`, `think`, `fetch_url` |
| Wards           | `maxTurns` (default 20), `requireDoneTool` (default false) |
| Entity          | `CantripEntity` Durable Object |
| Loom            | D1 database `cantrip-loom`, `turns` table |
| Cast (one-shot) | `POST /cast` → fresh entity each call |
| Summon (persistent) | `POST /entity/:id/cast` → same DO instance |

## Setup & Deploy

### Prerequisites
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+

### 1. Clone and run setup

```bash
git clone https://github.com/YOUR_USERNAME/cantrip-worker.git
cd cantrip-worker
chmod +x setup.sh
./setup.sh
```

`setup.sh` handles everything for a fresh deploy in one command:
- Logs you in to Wrangler if needed
- Creates the `cantrip-loom` D1 database and writes the ID into `wrangler.toml` automatically
- Applies the schema
- Installs npm dependencies
- Prompts you to set `API_SECRET`

### 2. (Optional) Set your CORS origin

In `wrangler.toml`, set `ALLOWED_ORIGIN` to your frontend's domain:

```toml
ALLOWED_ORIGIN = "https://yourdomain.com"
```

Leave it empty to block all cross-origin requests (fine for server-to-server use).

### 3. Deploy

```bash
npx wrangler deploy
```

Your worker will be live at `https://cantrip-worker.YOUR_SUBDOMAIN.workers.dev`.

---

### Manual setup (if you prefer not to use setup.sh)

```bash
npm install
npx wrangler d1 create cantrip-loom --update-config
npx wrangler d1 execute cantrip-loom --file=schema.sql --remote
npx wrangler secret put API_SECRET
npx wrangler deploy
```

---

### GitHub Actions (auto-deploy on push)

The repo includes `.github/workflows/deploy.yml` which deploys to Cloudflare
on every push to `main`.

Add these secrets to your GitHub repo
(**Settings → Secrets and variables → Actions**):

| Secret | Where to get it |
|--------|----------------|
| `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → right sidebar on any page |
| `API_SECRET` | Run `openssl rand -hex 32` locally and paste the output |

Once set, every push to `main` triggers a deploy automatically.

---

### Local development

```bash
wrangler dev
```

Note: Workers AI calls are proxied through Cloudflare even locally,
so you need to be logged in (`wrangler login`).

## API

### One-shot cast
```http
POST /cast
Content-Type: application/json

{
  "intent": "What is the capital of France?",
  "identity": {
    "systemPrompt": "You are a geography expert.",
    "maxTokens": 256
  },
  "circle": {
    "wards": { "maxTurns": 5 }
  }
}
```

Response:
```json
{
  "entity_id": "uuid",
  "cantrip_id": "uuid",
  "result": "Paris",
  "turns": 1,
  "terminated": true,
  "truncated": false
}
```

### Persistent entity (summon semantics)
```http
POST /entity/my-agent-123/cast
Content-Type: application/json

{ "intent": "Remember that my name is Alice." }
```

Then later:
```http
POST /entity/my-agent-123/cast
Content-Type: application/json

{ "intent": "What is my name?" }
```

The entity remembers Alice because all casts to `my-agent-123` land on
the same Durable Object with the same message history.

### Inspect the loom thread
```http
GET /entity/my-agent-123/thread
```

Returns every turn recorded for that entity — utterances, observations,
gate calls, token counts, terminated/truncated flags.

## Extending gates

Add a new gate in `gates.ts`:

```typescript
export const SEARCH_GATE: GateDefinition = {
  name: "search",
  description: "Search the web for current information.",
  parameters: {
    query: { type: "string", description: "Search query." }
  },
  required: ["query"],
};
```

Then handle it in `executeGate()` and add it to `DEFAULT_CIRCLE.gates`
in `entity.ts`.

## Limitations vs full spec

- **Code medium not implemented** — tool-calling circle only (the mandatory
  conformance tier). Adding a code medium on Workers would require either
  `eval()` in the DO isolate (weak isolation) or routing to an external
  sandbox (E2B, Fly.io microVM).

- **Models** — Workers AI only hosts open-weight models. For Claude/GPT,
  replace `queryLLM()` in `llm.ts` with an external API call.

- **Composition** — `call_entity` (child entity spawning) is not yet
  implemented. The architecture supports it: a child cast would spin up
  a new DO and share the same loom DB.

- **Folding** — context window management (§6.8) not yet implemented.
  Long-running entities will eventually hit model context limits.
