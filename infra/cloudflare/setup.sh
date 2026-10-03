#!/usr/bin/env bash
# Registers the AI Gateway and the "runpod" custom provider (first time only).
#
#   bash infra/cloudflare/setup.sh           # show what would be created
#   bash infra/cloudflare/setup.sh --apply   # create what is missing
#
# Requires: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (AI Gateway - Read and Edit)
# Optional: CF_AIG_GATEWAY_ID (default: runpod)
#
# Existing resources are never changed. If one differs from the wanted settings,
# the script stops and prints the difference.
set -euo pipefail

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
GATEWAY_ID="${CF_AIG_GATEWAY_ID:-runpod}"

PROVIDER_SLUG="runpod" # requests use /custom-runpod/...
# Domain only: the gateway inserts "/v1" into paths without a "v<digit>" segment,
# so callers put "/v2/..." in the path themselves (custom-runpod/v2/{id}/run).
PROVIDER_BASE_URL="https://api.runpod.ai"

API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai-gateway"

# cf METHOD PATH [JSON] -> prints the response body; exits on non-2xx except 404 on GET.
cf() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" --data "$body")
  local out code
  out=$(curl "${args[@]}" "${API}${path}")
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [[ "$code" == 2* ]] || [[ "$method" == GET && "$code" == 404 ]]; then
    printf '%s' "$out"
  else
    echo "error: $method $path -> HTTP $code" >&2
    echo "$out" | jq -c '.errors' >&2 || echo "$out" >&2
    exit 1
  fi
}

# --- Gateway -----------------------------------------------------------------
# Authentication on, cache off (LLM answers must not be reused), no rate limit.
GATEWAY_BODY=$(jq -nc --arg id "$GATEWAY_ID" '{
  id: $id,
  authentication: true,
  cache_ttl: 0,
  cache_invalidate_on_update: false,
  collect_logs: true,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0
}')

gateway=$(cf GET "/gateways/${GATEWAY_ID}")
if [[ $(jq -r '.success' <<<"$gateway") == true ]]; then
  diff=$(jq -c '.result | {authentication, cache_ttl} | with_entries(select(
    (.key == "authentication" and .value != true) or (.key == "cache_ttl" and .value != 0)))' <<<"$gateway")
  if [[ "$diff" != "{}" ]]; then
    echo "gateway '${GATEWAY_ID}' exists but differs (want authentication=true, cache_ttl=0): $diff" >&2
    exit 1
  fi
  echo "ok      gateway '${GATEWAY_ID}'"
elif $APPLY; then
  cf POST "/gateways" "$GATEWAY_BODY" >/dev/null
  echo "created gateway '${GATEWAY_ID}'"
else
  echo "create  gateway '${GATEWAY_ID}' $GATEWAY_BODY"
fi

# --- Custom provider (account-level, shared by every gateway) -----------------
PROVIDER_BODY=$(jq -nc --arg slug "$PROVIDER_SLUG" --arg url "$PROVIDER_BASE_URL" '{
  name: "Runpod",
  slug: $slug,
  base_url: $url,
  enable: true,
  description: "Runpod Serverless (managed by Loorel)"
}')

provider=$(cf GET "/custom-providers?per_page=50" | jq -c --arg slug "$PROVIDER_SLUG" '.result[] | select(.slug == $slug)')
if [[ -n "$provider" ]]; then
  diff=$(jq -c --arg url "$PROVIDER_BASE_URL" '{base_url, enable} | with_entries(select(
    (.key == "base_url" and .value != $url) or (.key == "enable" and .value != true)))' <<<"$provider")
  if [[ "$diff" != "{}" ]]; then
    echo "custom provider '${PROVIDER_SLUG}' exists but differs (want base_url=${PROVIDER_BASE_URL}, enable=true): $diff" >&2
    exit 1
  fi
  echo "ok      custom provider '${PROVIDER_SLUG}' -> ${PROVIDER_BASE_URL}"
elif $APPLY; then
  cf POST "/custom-providers" "$PROVIDER_BODY" >/dev/null
  echo "created custom provider '${PROVIDER_SLUG}' -> ${PROVIDER_BASE_URL}"
else
  echo "create  custom provider $PROVIDER_BODY"
fi

$APPLY || echo "(plan only; run with --apply to create)"
echo "endpoint URL: https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${GATEWAY_ID}/custom-${PROVIDER_SLUG}/v2/{endpointId}"
