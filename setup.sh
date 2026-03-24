#!/usr/bin/env bash
# setup.sh — run once before first deploy on a fresh clone
#
# What it does:
#   1. Checks you're logged in to Wrangler
#   2. Creates the cantrip-loom D1 database (skips if it already exists)
#   3. Writes the database_id into wrangler.toml automatically
#   4. Applies the schema
#   5. Prompts you to set the API_SECRET
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

info()    { echo -e "${BOLD}▶ $1${RESET}"; }
success() { echo -e "${GREEN}✓ $1${RESET}"; }
warn()    { echo -e "${YELLOW}⚠ $1${RESET}"; }
error()   { echo -e "${RED}✗ $1${RESET}"; exit 1; }

# ── 0. Prerequisites ──────────────────────────────────────────────────────────

info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Install it from https://nodejs.org"
fi

if ! npx wrangler whoami &>/dev/null 2>&1; then
  warn "Not logged in to Wrangler. Running wrangler login..."
  npx wrangler login
fi

success "Prerequisites OK"

# ── 1. Create D1 database ─────────────────────────────────────────────────────

DB_NAME="cantrip-loom"
info "Setting up D1 database '$DB_NAME'..."

# Check if the DB already exists in wrangler.toml (i.e. already set up)
if grep -q 'YOUR_DATABASE_ID_HERE' wrangler.toml; then
  info "Creating database and updating wrangler.toml..."
  # --update-config writes the database_id directly into wrangler.toml
  npx wrangler d1 create "$DB_NAME" --update-config || {
    # If creation fails because it already exists remotely, fetch the ID
    warn "Database may already exist. Fetching existing ID..."
    DB_ID=$(npx wrangler d1 list --json 2>/dev/null \
      | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
                 const dbs=JSON.parse(d); \
                 const db=dbs.find(x=>x.name==='$DB_NAME'); \
                 if(db) process.stdout.write(db.uuid); else process.exit(1)") \
      || error "Could not find or create database '$DB_NAME'. Run: npx wrangler d1 create $DB_NAME"

    # Patch the placeholder in wrangler.toml
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/YOUR_DATABASE_ID_HERE/$DB_ID/" wrangler.toml
    else
      sed -i "s/YOUR_DATABASE_ID_HERE/$DB_ID/" wrangler.toml
    fi
    success "Patched wrangler.toml with database_id: $DB_ID"
  }
else
  success "wrangler.toml already has a database_id — skipping creation"
fi

success "Database configured"

# ── 2. Apply schema ───────────────────────────────────────────────────────────

info "Applying schema to '$DB_NAME'..."
npx wrangler d1 execute "$DB_NAME" --file=schema.sql --remote
success "Schema applied"

# ── 3. Install dependencies ───────────────────────────────────────────────────

info "Installing dependencies..."
npm install
success "Dependencies installed"

# ── 4. Set API secret ─────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
info "Setting API secret..."
echo ""
echo "  Generate a strong secret with:"
echo -e "  ${BOLD}  openssl rand -hex 32${RESET}"
echo ""
echo "  Then set it with:"
echo -e "  ${BOLD}  npx wrangler secret put API_SECRET${RESET}"
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

read -p "Set API_SECRET now? [Y/n] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
  npx wrangler secret put API_SECRET
  success "API_SECRET set"
else
  warn "Skipped. Remember to run: npx wrangler secret put API_SECRET before deploying"
fi

# ── 5. Done ───────────────────────────────────────────────────────────────────

echo ""
success "Setup complete! You can now deploy with:"
echo ""
echo -e "  ${BOLD}npx wrangler deploy${RESET}"
echo ""
