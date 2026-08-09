#!/usr/bin/env bash
# Render the Caddy auth gateway config (deploy/Caddyfile) from the template.
#
# Generates a bearer API key + a Basic-Auth UI password, bcrypt-hashes the
# password, and bakes them into deploy/Caddyfile (gitignored — secrets stay
# local, never committed). Reuses MYCELIUM_API_KEY / UI_USER / UI_PASS from the
# environment or .env if present, so re-running preserves existing credentials.
#
# No secrets are written to the repo. deploy/Caddyfile is gitignored.
#
# Usage:
#   cp .env.example .env   # then fill in your LLM_* config
#   bash deploy/setup-gateway.sh
#   docker compose -f docker-compose.caddy.yml up -d --build
set -euo pipefail

cd "$(dirname "$0")/.."

TPL="deploy/Caddyfile.template"
OUT="deploy/Caddyfile"

if [ ! -f "$TPL" ]; then
  echo "error: $TPL not found (run from the repo root)" >&2
  exit 1
fi

# Load .env if present, so pre-set credentials are reused instead of regenerated.
if [ -f .env ]; then set -a; . ./.env; set +a; fi

MYCELIUM_API_KEY="${MYCELIUM_API_KEY:-$(openssl rand -hex 24)}"
UI_USER="${UI_USER:-echo}"
if [ -z "${UI_PASS:-}" ]; then
  UI_PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"
fi
MYCELIUM_UPSTREAM="${MYCELIUM_UPSTREAM:-mycelium:3800}"

# bcrypt-hash the UI password using the same Caddy image the stack runs,
# so no host-level Caddy install is required.
if ! docker run --rm caddy:2-alpine caddy hash-password --plaintext "$UI_PASS" > /tmp/.mycelium_hash 2>/tmp/.mycelium_hash_err; then
  echo "error: failed to hash the UI password with the caddy image:" >&2
  cat /tmp/.mycelium_hash_err >&2
  exit 1
fi
UI_PASS_HASH="$(tr -d '\n' < /tmp/.mycelium_hash)"
rm -f /tmp/.mycelium_hash /tmp/.mycelium_hash_err

# Render the Caddyfile. sed delimiter is '|' (none of the values contain it;
# bcrypt hashes use [./A-Za-z0-9] and '$', which are literal in sed replacements).
sed \
  -e "s|__MYCELIUM_API_KEY__|${MYCELIUM_API_KEY}|g" \
  -e "s|__UI_USER__|${UI_USER}|g" \
  -e "s|__UI_PASS_HASH__|${UI_PASS_HASH}|g" \
  -e "s|__MYCELIUM_UPSTREAM__|${MYCELIUM_UPSTREAM}|g" \
  "$TPL" > "$OUT"
chmod 600 "$OUT"

# Record the credentials in .env (local, gitignored) so re-runs reuse them.
touch .env
update_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '\n%s=%s\n' "$key" "$val" >> .env
  fi
}
update_env MYCELIUM_API_KEY "$MYCELIUM_API_KEY"
update_env UI_USER "$UI_USER"
update_env UI_PASS "$UI_PASS"

echo "Rendered $OUT (mode 600)."
echo "---------------- CREDENTIALS (save these) ----------------"
echo "MYCELIUM_API_KEY = $MYCELIUM_API_KEY"
echo "  -> bearer token for /mcp and /api  (Authorization: Bearer <this>)"
echo "UI_USER          = $UI_USER"
echo "UI_PASS          = $UI_PASS"
echo "  -> Basic Auth for the web UI at /"
echo "---------------------------------------------------------"
echo
echo "Next: docker compose -f docker-compose.caddy.yml up -d --build"
echo "Then register an MCP client:"
echo "  claude mcp add mycelium -s user --transport http http://<host>:3800/mcp \\"
echo "    --header \"Authorization: Bearer $MYCELIUM_API_KEY\""