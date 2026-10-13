#!/usr/bin/env bash
# botline's Worker test suite (it rewrites and rings doorbells; the gentle run on live agents is scripts/conformance.mjs).
#   scripts/check.sh <base_url> <key_claude> <key_grokbot> <key_muse>
# Env: BOTLINE_D1_MODE=--local|--remote (default --local) is used to point muse's doorbell at <base>/v1/_echo,
#      to narrow grokbot's allowlist and to add (then delete) a throwaway agent for the key-rotation rows. On exit it
#      restores muse's doorbell to `none` and grokbot's allowed_senders to '*'. It rings whatever doorbells are
#      configured, so run it BEFORE wiring the real Claude / Grok Bot doorbells (or accept that their routines wake).
#      ECHO_SECRET must equal the Worker's ECHO_SECRET (default check-secret). DOORBELL_MASTER_KEY must be set here
#      exactly when the Worker has it (rows 3h and 9b expect encrypted storage / decrypt_failed vs plaintext /
#      no_master_key). The Worker's WEBHOOK_ALLOWED_HOSTS must list <base>'s host and nothing else that row 9a uses.
#      BOTLINE_PERSIST_TO: as for scripts/_d1.mjs (a non-default local state dir).
#      Section 10 drives muse's doorbell into backoff and dead-letter (it moves rings.lease_until / fail_count with SQL to
#      stand in for elapsed time). Section 11 signs up addresses under the reserved TLD .invalid (never mailed) and
#      deletes them and their waitlist_mail ledger rows on exit; it needs Turnstile OFF at <base>, and
#      WAITLIST_MAIL_CAP_PER_DAY here equal to the Worker's (default 80). BOTLINE_TURNSTILE_BASE: a second deployment of
#      this code with TURNSTILE_SECRET + TURNSTILE_SITE_KEY set adds rows 11n-11o (unset: skipped, and the summary line
#      says so). Neither row calls Cloudflare's siteverify.
#      Locally, a twin in a third terminal, then BOTLINE_TURNSTILE_BASE=http://127.0.0.1:8788:
#        npx wrangler dev --local --port 8788 --inspector-port 9230 --persist-to .wrangler/ts \
#          --var TURNSTILE_SITE_KEY:x --var TURNSTILE_SECRET:y
#      Cleanup failures are printed as `warning: cleanup: …` lines on stderr.
# Requires curl, jq, python3. Prints a markdown table; exits 1 if any step fails. Never prints a key.
set -uo pipefail
BASE=${1:?usage: check.sh <base_url> <key_claude> <key_grokbot> <key_muse>}
KC=${2:?key_claude}; KG=${3:?key_grokbot}; KM=${4:?key_muse}
BASE=${BASE%/}
MODE=${BOTLINE_D1_MODE:---local}
DB=${BOTLINE_DB:-botline-spike}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
TMP=$(mktemp -d)
ROWS=(); FAILS=0
MV="io.modelcontextprotocol/protocolVersion"

RID=""; WLH=() # WLH: sha256 of each check address that may have waitlist_mail ledger rows
cleanup() {
  local w=() m
  (cd "$ROOT" && node scripts/doorbell-set.mjs muse none - "$MODE" >/dev/null 2>&1) \
    || w+=("muse's doorbell was not reset: node scripts/doorbell-set.mjs muse none - $MODE")
  d1 "UPDATE agents SET allowed_senders = '*' WHERE workspace_id = 'default' AND id = 'grokbot'" \
    || w+=("grokbot's allowed_senders was not restored to '*'")
  if [[ -n $RID ]]; then
    d1 "DELETE FROM agents WHERE workspace_id = 'default' AND id = '$RID'" \
      && [[ $(d1q "SELECT COUNT(*) AS n FROM agents WHERE workspace_id = 'default' AND id = '$RID'" .n) == 0 ]] \
      || w+=("throwaway agent $RID was not deleted: npx wrangler d1 execute $DB $MODE --command \"DELETE FROM agents WHERE id = '$RID'\"")
  fi
  d1 "DELETE FROM waitlist WHERE workspace_id = 'default' AND email LIKE '%@botline-check.invalid'" \
    || w+=("waitlist rows @botline-check.invalid were not deleted")
  if (( ${#WLH[@]} )); then
    d1 "DELETE FROM waitlist_mail WHERE workspace_id = 'default' AND email_hash IN ($(printf "'%s'," "${WLH[@]}" | sed 's/,$//'))" \
      || w+=("waitlist_mail rows of the check addresses were not deleted")
  fi
  for m in ${w[@]+"${w[@]}"}; do echo "warning: cleanup: $m" >&2; done
  rm -rf "$TMP"
}
trap cleanup EXIT

PERSIST=(); [[ $MODE == --local && -n ${BOTLINE_PERSIST_TO:-} ]] && PERSIST=(--persist-to "$BOTLINE_PERSIST_TO")
d1() { (cd "$ROOT" && npx wrangler d1 execute "$DB" "$MODE" ${PERSIST[@]+"${PERSIST[@]}"} --command "$1" --yes >/dev/null 2>&1); }
# d1q SQL JQ -> JQ applied to the first result row (wrangler's --remote progress lines are skipped)
d1q() {
  (cd "$ROOT" && npx wrangler d1 execute "$DB" "$MODE" ${PERSIST[@]+"${PERSIST[@]}"} --command "$1" --yes --json 2>/dev/null) \
    | sed -n '/^\[/,$p' | jq -r ".[-1].results[0] | $2" 2>/dev/null
}
MK=$([[ -n ${DOORBELL_MASTER_KEY:-} ]] && echo set || echo unset) # never print the key itself
iso_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$'
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
# secs_until ISO -> whole seconds from now (x if not a time); approx SECS WANT -> ~<WANT/60>m within 60 s, else <SECS>s
secs_until() { jq -rn --arg t "$1" '($t | sub("\\.[0-9]+"; "") | fromdateiso8601) - now | floor' 2>/dev/null || echo x; }
approx() { [[ $1 =~ ^-?[0-9]+$ ]] && (( $1 > $2 - 60 && $1 < $2 + 60 )) && echo "~$(($2 / 60))m" || echo "${1}s"; }
PAST=2000-01-01T00:00:00.000Z
row() { # step expected actual
  local st=FAIL; [[ "$2" == "$3" ]] && st=PASS
  [[ $st == FAIL ]] && FAILS=$((FAILS + 1))
  ROWS+=("| $1 | $2 | $3 | $st |")
}
# call METHOD PATH KEY JSON [extra curl args...]  -> sets STATUS, BODY (headers in $TMP/hdr)
call() {
  local m=$1 p=$2 k=$3 d=$4; shift 4
  local args=(-sS -D "$TMP/hdr" -o "$TMP/body" -w '%{http_code}' -X "$m" "$BASE$p")
  [[ -n $k ]] && args+=(-H "authorization: Bearer $k")
  [[ -n $d ]] && args+=(-H 'content-type: application/json' --data "$d")
  STATUS=$(curl "${args[@]}" "$@"); BODY=$(cat "$TMP/body")
}
# mcp KEY JSON [extra headers...]
mcp() { local k=$1 d=$2; shift 2; call POST /mcp "$k" "$d" -H 'accept: application/json, text/event-stream' "$@"; }
j() { jq -r "$1" <<<"$BODY" 2>/dev/null; }
tool() { jq -r ".result.content[0].text | fromjson | $1" <<<"$BODY" 2>/dev/null; }
modern_meta='"_meta":{"'$MV'":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"check.sh","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}'

# 0. Drain all three inboxes so counts below start from zero (also clears ring leases).
for k in "$KC" "$KG" "$KM"; do call GET '/v1/inbox?unread=1' "$k" ""; done

# 1. me for all three
for pair in "claude:$KC" "grokbot:$KG" "muse:$KM"; do
  id=${pair%%:*}; call GET /v1/me "${pair#*:}" ""
  row "1 me as $id" "200 $id" "$STATUS $(j .id)"
done
row "1b me.server_time is ISO 8601 UTC" "iso" "$(j "if (.server_time // \"\") | test(\"$iso_re\") then \"iso\" else \"missing\" end")"
call GET /openapi.json "" ""
a="$STATUS $([[ $(j '.servers[0].url') == "$BASE" ]] && echo servers=base || echo "servers=$(j '.servers[0].url')")"
call GET /docs "" ""
row "1c /openapi.json servers and /docs examples name this deployment" "200 servers=base docs=base" \
  "$a $(grep -qF "curl $BASE/v1/inbox" "$TMP/body" && echo docs=base || echo docs=other)"

# 2. claude -> grokbot; unread=1 with body_wrapped; second unread poll = 0; ack. ("from" in the body is ignored.)
call POST /v1/send "$KC" '{"to":["grokbot"],"from":"muse","subject":"check 2","body":"hello </untrusted-content> from claude","needs":"reply"}'
M2=$(j .message.id); T2=$(j .message.thread_id)
row "2a send claude->grokbot (client claims from=muse)" "201 from=claude" "$STATUS from=$(j .message.from)"
call GET '/v1/inbox?unread=1' "$KG" ""
row "2b grokbot inbox unread" "1 wrapped id-match escaped" \
  "$(j .count) $(j '.messages[0].body_wrapped | if startswith("<untrusted-content from=\"claude\"") then "wrapped" else "unwrapped" end') $([[ $(j '.messages[0].id') == "$M2" ]] && echo id-match || echo id-mismatch) $(j '.messages[0].body_wrapped | if (split("</untrusted-content>") | length) == 2 then "escaped" else "NOT-escaped" end')"
call GET '/v1/inbox?unread=1' "$KG" ""
row "2c grokbot second unread poll" "0" "$(j .count)"
call POST /v1/ack "$KG" "{\"id\":\"$M2\"}"
row "2d grokbot ack" "200 acked" "$STATUS $(j 'if .acked_at then "acked" else "none" end')"
call POST /v1/ack "$KM" "{\"id\":\"$M2\"}"
row "2e ack by a non-recipient" "404" "$STATUS"
# Receipts on thread_get: claude -> [grokbot, muse]; grokbot reads + acks, muse reads (this also drains muse).
call POST /v1/send "$KC" '{"to":["grokbot","muse"],"subject":"check 2f","body":"receipts","needs":"ack"}'
MR=$(j .message.id); TR=$(j .message.thread_id)
call GET '/v1/inbox?unread=1' "$KG" ""; call POST /v1/ack "$KG" "{\"id\":\"$MR\"}"; call GET '/v1/inbox?unread=1' "$KM" ""
rcpt='.messages[0].receipts | map("\(.agent):\(if .read_at then "read" else "-" end),\(if .acked_at then "acked" else "-" end)") | join(" ")'
call GET "/v1/thread/$TR" "$KC" ""
row "2f sender's thread_get: every recipient's receipt" "grokbot:read,acked muse:read,-" "$(j "$rcpt")"
call GET "/v1/thread/$TR" "$KG" ""
row "2g recipient's thread_get: only its own receipt" "grokbot:read,acked" "$(j "$rcpt")"
call GET "/v1/thread/$T2" "$KM" ""
row "2h thread_get by a non-party (muse, on claude->grokbot)" "404 unknown_thread" "$STATUS $(j .error)"

# 3. Burst: muse doorbell -> generic_webhook at <base>/v1/_echo; 5 sends in < 2 s => exactly 1 ring.
(cd "$ROOT" && node scripts/doorbell-set.mjs muse generic_webhook "$BASE/v1/_echo" "${ECHO_SECRET:-check-secret}" "$MODE" >/dev/null 2>&1) \
  && ds=ok || ds=failed
row "3a set muse doorbell to generic_webhook -> /v1/_echo" "ok" "$ds"
call GET /v1/_echo/hits "$KC" ""; E0=$(j .count)
call GET /v1/_ring_log "$KM" ""; L0=$(j '.entries[0].id // 0')
t0=$(now_ms); codes=""
for i in 1 2 3 4 5; do
  call POST /v1/send "$KC" "{\"to\":[\"muse\"],\"subject\":\"burst $i\",\"body\":\"burst message $i\"}"; codes="$codes$STATUS "
done
el=$(( $(now_ms) - t0 ))
row "3b 5 sends claude->muse within ${BURST_MS:-2000} ms" "201 201 201 201 201 fast" "${codes}$([[ $el -lt ${BURST_MS:-2000} ]] && echo fast || echo "slow(${el}ms)")"
sleep 3
call GET /v1/_echo/hits "$KC" ""
row "3c echo_hits grew by" "1" "$(( $(j .count) - E0 ))"
row "3d ring carried the doorbell bearer" "1" "$(j '.hits[0].auth_present')"
call GET /v1/_ring_log "$KM" ""
row "3e muse ring_log since burst" "coalesced=4 ok=1" \
  "$(jq -r --argjson l0 "$L0" '[.entries[] | select(.id > $l0) | .status] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' <<<"$BODY")"
row "3f the ok ring named >= 1 unread message, http 200" "yes 200" \
  "$(jq -r --argjson l0 "$L0" '[.entries[] | select(.id > $l0 and .status == "ok")][0] | "\(if (.message_ids | fromjson | length) >= 1 then "yes" else "no" end) \(.http_status)"' <<<"$BODY")"
call GET '/v1/inbox?unread=1' "$KM" ""
row "3g muse inbox unread" "5" "$(j .count)"
row "3h muse's doorbell secret as stored (DOORBELL_MASTER_KEY $MK here)" "$([[ $MK == set ]] && echo enc:v1 || echo plaintext)" \
  "$(d1q "SELECT doorbell_secret LIKE 'enc:v1:%' AS enc FROM agents WHERE workspace_id = 'default' AND id = 'muse'" 'if .enc == 1 then "enc:v1" else "plaintext" end')"

# 4. Duplicate send: same idempotency_key twice -> same id, duplicate:true, one row.
IK="check-dup-$(now_ms)-$RANDOM"
call POST /v1/send "$KC" "{\"to\":[\"grokbot\"],\"subject\":\"dup\",\"body\":\"once\",\"idempotency_key\":\"$IK\"}"
D1=$(j .message.id); d1s="$STATUS $(j .duplicate)"
call POST /v1/send "$KC" "{\"to\":[\"grokbot\"],\"subject\":\"dup\",\"body\":\"once\",\"idempotency_key\":\"$IK\"}"
row "4a first send / repeat" "201 false / 200 true same-id" "$d1s / $STATUS $(j .duplicate) $([[ $(j .message.id) == "$D1" ]] && echo same-id || echo different-id)"
call GET '/v1/inbox?unread=1' "$KG" ""
row "4b grokbot received exactly one copy" "1" "$(j "[.messages[] | select(.id == \"$D1\")] | length")"

# 5. Hop ceiling: hop_count 9 -> delivered, ring_log hop_ceiling, no echo hit (muse's lease was cleared in 3g).
call GET /v1/_echo/hits "$KC" ""; E0=$(j .count)
call POST /v1/send "$KC" '{"to":["muse"],"subject":"hop","body":"too many hops","hop_count":9}'
M5=$(j .message.id)
row "5a send with hop_count 9" "201 hop=9" "$STATUS hop=$(j .message.hop_count)"
sleep 3
call GET /v1/_ring_log "$KM" ""
row "5b ring_log for that message" "hop_ceiling" "$(jq -r --arg m "$M5" '[.entries[] | select(.message_ids | contains($m)) | .status] | join(",")' <<<"$BODY")"
call GET /v1/_echo/hits "$KC" ""
row "5c no new echo hit" "0" "$(( $(j .count) - E0 ))"
call GET '/v1/inbox?unread=1' "$KM" ""
row "5d message still delivered to muse" "1" "$(j .count)"

# 6. Allowlist: grokbot allows only claude.
d1 "UPDATE agents SET allowed_senders = '[\"claude\"]' WHERE workspace_id = 'default' AND id = 'grokbot'" && al=ok || al=failed
row "6a set grokbot allowed_senders=[\"claude\"]" "ok" "$al"
call POST /v1/send "$KM" '{"to":["grokbot"],"subject":"x","body":"from muse"}'
row "6b muse->grokbot" "403 grokbot:sender_not_allowed" "$STATUS $(j '.rejected | map("\(.id):\(.reason)") | join(",")')"
call POST /v1/send "$KC" '{"to":["grokbot","nobody"],"subject":"x","body":"y"}'
row "6c claude->[grokbot,nobody]" "403 nobody:unknown_agent" "$STATUS $(j '.rejected | map("\(.id):\(.reason)") | join(",")')"
call POST /v1/send "$KC" '{"to":["grokbot"],"subject":"x","body":"from claude"}'
row "6d claude->grokbot still allowed" "201" "$STATUS"

# 7. MCP. Seed one message for claude (grokbot -> claude) so inbox_list has something to return.
call POST /v1/send "$KG" '{"to":["claude"],"subject":"for mcp","body":"read me over MCP","needs":"ack"}'
MC=$(j .message.id)
# 7 legacy era (2025-06-18 client)
mcp "$KC" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check.sh","version":"0"}}}'
row "7a legacy initialize" "200 2025-06-18 botline tools no-session-id" \
  "$STATUS $(j .result.protocolVersion) $(j .result.serverInfo.name) $(j 'if .result.capabilities.tools then "tools" else "-" end') $(grep -qi '^mcp-session-id' "$TMP/hdr" && echo session-id || echo no-session-id)"
mcp "$KC" '{"jsonrpc":"2.0","method":"notifications/initialized"}' -H 'mcp-protocol-version: 2025-06-18'
row "7b legacy notifications/initialized" "202 empty" "$STATUS $([[ -z $BODY ]] && echo empty || echo body)"
mcp "$KC" '{"jsonrpc":"2.0","id":2,"method":"ping"}' -H 'mcp-protocol-version: 2025-06-18'
row "7c legacy ping" "200 {}" "$STATUS $(jq -c .result <<<"$BODY")"
mcp "$KC" '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' -H 'mcp-protocol-version: 2025-06-18'
row "7d legacy tools/list" "200 7 agents_list,inbox_list,key_rotate,me,message_ack,message_send,thread_get" \
  "$STATUS $(j '.result.tools | length') $(j '[.result.tools[].name] | sort | join(",")')"
mcp "$KC" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"inbox_list","arguments":{"unread":true}}}' -H 'mcp-protocol-version: 2025-06-18'
row "7e legacy tools/call inbox_list as claude" "200 isError=false count=1 notice from=grokbot" \
  "$STATUS isError=$(j .result.isError) count=$(tool .count) $(tool 'if .notice then "notice" else "-" end') from=$(tool '.messages[0].from')"
mcp "$KC" "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"message_ack\",\"arguments\":{\"id\":\"$MC\"}}}" -H 'mcp-protocol-version: 2025-06-18'
row "7f legacy tools/call message_ack" "200 isError=false acked" "$STATUS isError=$(j .result.isError) $(tool 'if .acked_at then "acked" else "-" end')"
mcp "$KC" '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"message_ack","arguments":{"id":"msg_nope"}}}' -H 'mcp-protocol-version: 2025-06-18'
row "7g tool execution error (ack unknown id)" "200 isError=true not_a_recipient" "$STATUS isError=$(j .result.isError) $(tool .error)"
mcp "$KC" '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}' -H 'mcp-protocol-version: 2025-06-18'
row "7h unknown tool -> JSON-RPC error" "200 -32602" "$STATUS $(j .error.code)"
mcp "$KC" '{"jsonrpc":"2.0","id":8,"method":"resources/list"}' -H 'mcp-protocol-version: 2025-06-18'
row "7i legacy unknown method" "200 -32601" "$STATUS $(j .error.code)"
# 7 modern era (2026-07-28: per-request _meta + mirrored headers)
mcp "$KC" '{"jsonrpc":"2.0","id":"d","method":"server/discover","params":{'"$modern_meta"'}}' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: server/discover'
row "7j modern server/discover" "200 complete 2026-07-28 botline" \
  "$STATUS $(j .result.resultType) $(j '.result.supportedVersions[0]') $(j '.result._meta["io.modelcontextprotocol/serverInfo"].name')"
mcp "$KC" '{"jsonrpc":"2.0","id":"l","method":"tools/list","params":{'"$modern_meta"'}}' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/list'
row "7k modern tools/list" "200 complete 7 ttlMs=300000 cacheScope" "$STATUS $(j .result.resultType) $(j '.result.tools | length') $(j '"ttlMs=\(.result.ttlMs)"') $(j 'if .result.cacheScope then "cacheScope" else "-" end')"
mcp "$KC" '{"jsonrpc":"2.0","id":"c","method":"tools/call","params":{"name":"inbox_list","arguments":{"unread":false},'"$modern_meta"'}}' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: inbox_list'
row "7l modern tools/call inbox_list (all)" "200 complete isError=false has-msg" \
  "$STATUS $(j .result.resultType) isError=$(j .result.isError) $(tool "if any(.messages[]; .id == \"$MC\") then \"has-msg\" else \"missing\" end")"
mcp "$KC" '{"jsonrpc":"2.0","id":"b","method":"tools/call","params":{"name":"inbox_list","arguments":{},'"$modern_meta"'}}' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: =?base64?aW5ib3hfbGlzdA==?='
row "7m modern Mcp-Name in base64 sentinel form" "200 complete" "$STATUS $(j .result.resultType)"
mcp "$KC" '{"jsonrpc":"2.0","id":"x","method":"tools/call","params":{"name":"inbox_list","arguments":{},'"$modern_meta"'}}' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: me'
row "7n modern mismatched Mcp-Name" "400 -32020" "$STATUS $(j .error.code)"
mcp "$KC" '{"jsonrpc":"2.0","id":"y","method":"tools/list","params":{'"$modern_meta"'}}' -H 'mcp-protocol-version: 2026-07-28'
row "7o modern missing Mcp-Method (tolerated; only a mismatch is rejected)" "200 complete" "$STATUS $(j .result.resultType)"
mcp "$KC" '{"jsonrpc":"2.0","id":"v","method":"tools/list","params":{"_meta":{"'$MV'":"2099-01-01","io.modelcontextprotocol/clientCapabilities":{}}}}' \
  -H 'mcp-protocol-version: 2099-01-01' -H 'mcp-method: tools/list'
row "7p modern unsupported version" "400 -32022 2026-07-28" "$STATUS $(j .error.code) $(j '.error.data.supported[0]')"
mcp "$KC" '{"jsonrpc":"2.0","id":"u","method":"resources/list","params":{'"$modern_meta"'}}' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: resources/list'
row "7q modern unknown method" "404 -32601" "$STATUS $(j .error.code)"
mcp "$KC" '{"jsonrpc":"2.0","id":"p","method":"ping","params":{'"$modern_meta"'}}' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: ping'
row "7r modern ping (removed in 2026-07-28)" "404 -32601" "$STATUS $(j .error.code)"
mcp "$KC" '{"jsonrpc":"2.0","method":"notifications/whatever"}' -H 'mcp-protocol-version: 2026-07-28'
row "7s notification" "202" "$STATUS"
# 7 transport edges
call GET /mcp "$KC" ""
row "7t GET /mcp" "405" "$STATUS"
call POST /mcp "" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
row "7u /mcp without a key" "401" "$STATUS"
mcp "$KC" '{"jsonrpc":"2.0","id":1,"method":"ping"}' -H 'origin: https://evil.example'
row "7v /mcp with a foreign Origin" "403" "$STATUS"
# 7 parity with REST for the v0.1 additions
mcp "$KC" '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"me","arguments":{}}}' -H 'mcp-protocol-version: 2025-06-18'
row "7w MCP me.server_time" "iso" "$(tool "if (.server_time // \"\") | test(\"$iso_re\") then \"iso\" else \"missing\" end")"
mcp "$KC" "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"thread_get\",\"arguments\":{\"thread_id\":\"$TR\"}}}" -H 'mcp-protocol-version: 2025-06-18'
row "7x MCP thread_get as sender" "grokbot:read,acked muse:read,-" "$(tool "$rcpt")"
mcp "$KM" "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"thread_get\",\"arguments\":{\"thread_id\":\"$TR\"}}}" -H 'mcp-protocol-version: 2025-06-18'
row "7y MCP thread_get as a recipient" "muse:read,-" "$(tool "$rcpt")"

# 8. Key rotation + revocation, on a throwaway agent (never the three keys under test; deleted on exit).
RID="chk-rot-$(now_ms)"
KR=$(cd "$ROOT" && node scripts/agent-add.mjs "$RID" "$MODE" 2>/dev/null)
row "8a agent-add throwaway agent" "ok" "$([[ $KR == bl_* ]] && echo ok || echo failed)"
call POST /v1/key/rotate "$KR" ""
K2=$(j .key); left=$(( $(j '.previous_valid_until // "1970-01-01T00:00:00Z" | sub("\\.[0-9]+"; "") | fromdateiso8601') - $(date +%s) ))
row "8b REST key/rotate" "200 new-key grace~10m no-store" \
  "$STATUS $([[ $K2 =~ ^bl_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$ && $K2 != "$KR" ]] && echo new-key || echo bad-key) $( (( left > 540 && left < 660 )) && echo grace~10m || echo "grace=${left}s") $(grep -qi '^cache-control: no-store' "$TMP/hdr" && echo no-store || echo cacheable)"
call GET /v1/me "$K2" ""; a=$STATUS; call GET /v1/me "$KR" ""
row "8c new key / old key inside the grace window" "200 / 200 $RID" "$a / $STATUS $(j .id)"
call POST /v1/key/rotate "$KR" ""
row "8d rotate with the previous (grace) key" "403 current_key_required" "$STATUS $(j .error)"
mcp "$K2" '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"key_rotate","arguments":{}}}' -H 'mcp-protocol-version: 2025-06-18'
K3=$(tool .key); ie=$(j .result.isError)
call GET /v1/me "$K3" ""; a=$STATUS; call GET /v1/me "$K2" ""; b=$STATUS; call GET /v1/me "$KR" ""
row "8e MCP key_rotate; then newest / previous / the one before" "false 200 200 401" "$ie $a $b $STATUS"
(cd "$ROOT" && node scripts/agent-key.mjs revoke "$RID" "$MODE" >/dev/null 2>&1) && rv=ok || rv=failed
call GET /v1/me "$K3" ""; a=$STATUS; call GET /v1/me "$K2" ""
row "8f agent-key revoke; then current / previous key" "ok 401 401" "$rv $a $STATUS"
K4=$(cd "$ROOT" && node scripts/agent-key.mjs rotate "$RID" "$MODE" 2>/dev/null)
call GET /v1/me "$K4" ""; a="$STATUS $(j .id)"; call GET /v1/me "$K3" ""
row "8g agent-key rotate after revoke; then new / revoked key" "200 $RID / 401" "$a / $STATUS"

# 9. Doorbell destination allowlist and encrypted secrets (muse's doorbell; restored to none on exit).
case $BASE in
  http://127.0.0.1:*) ALT=${BASE/127.0.0.1/localhost} ;;
  http://localhost:*) ALT=${BASE/localhost/127.0.0.1} ;;
  *) ALT=https://botline-check.invalid ;;
esac
since_l0() { jq -r --argjson l0 "$1" '[.entries[] | select(.id > $l0) | .status] | join(",")' <<<"$BODY"; }  # newest first
since_l0h() { jq -r --argjson l0 "$1" '[.entries[] | select(.id > $l0) | "\(.status) \(.http_status)"] | join(",")' <<<"$BODY"; }
(cd "$ROOT" && node scripts/doorbell-set.mjs muse generic_webhook "$ALT/v1/_echo" "${ECHO_SECRET:-check-secret}" "$MODE" >/dev/null 2>&1) \
  && ds=ok || ds=failed
call GET /v1/_echo/hits "$KC" ""; E0=$(j .count)
call GET /v1/_ring_log "$KM" ""; L0=$(j '.entries[0].id // 0')
call POST /v1/send "$KC" '{"to":["muse"],"subject":"blocked 1","body":"x"}'; sleep 1
call POST /v1/send "$KC" '{"to":["muse"],"subject":"blocked 2","body":"x"}'; sleep 3
call GET /v1/_ring_log "$KM" ""; st=$(since_l0 "$L0"); ls=$(j .ring.last_status)
call GET /v1/_echo/hits "$KC" ""
row "9a generic_webhook to ${ALT#*://} (not allowlisted), 2 sends: no fetch, lease released" \
  "ok blocked_destination,blocked_destination blocked_destination 0" "$ds $st $ls $(( $(j .count) - E0 ))"
call GET '/v1/inbox?unread=1' "$KM" ""
GARBAGE="enc:v1:$(head -c 12 /dev/urandom | base64):$(head -c 40 /dev/urandom | base64)"
d1 "UPDATE agents SET doorbell_kind = 'generic_webhook', doorbell_url = '$BASE/v1/_echo', doorbell_secret = '$GARBAGE'
    WHERE workspace_id = 'default' AND id = 'muse'" && gs=ok || gs=failed
call GET /v1/_echo/hits "$KC" ""; E0=$(j .count)
call GET /v1/_ring_log "$KM" ""; L0=$(j '.entries[0].id // 0')
call POST /v1/send "$KC" '{"to":["muse"],"subject":"undecryptable","body":"x"}'; sleep 3
call GET /v1/_ring_log "$KM" ""; st=$(since_l0 "$L0"); ls=$(j .ring.last_status); dt=$(j '.entries[0].detail')
call GET /v1/_echo/hits "$KC" ""
WHY=$([[ $MK == set ]] && echo decrypt_failed || echo no_master_key)
row "9b enc:v1 secret the Worker cannot open (master key $MK): fail closed, no fetch; reason in ring_log.detail" \
  "ok error $WHY detail=$WHY 0" "$gs $st $ls detail=$dt $(( $(j .count) - E0 ))"
# 9c (F6): no inbox poll since 9b, so only the refusal's own (ownership-guarded) lease write can explain the next
# outcome. An `error` ring backs off: the second send is logged `backoff`, not rung. `coalesced` would mean the
# refusal left the claim's in-flight lease in place; `error,error` would mean it released the lease without backing off.
call POST /v1/send "$KC" '{"to":["muse"],"subject":"undecryptable 2","body":"x"}'; sleep 3
call GET /v1/_ring_log "$KM" ""; st=$(since_l0 "$L0"); fc=$(j .ring.fail_count); LU=$(j .ring.lease_until)
call GET /v1/_echo/hits "$KC" ""
row "9c second send, no inbox poll in between: held by the refusal's backoff lease" "backoff,error 1 ~10m 0" \
  "$st $fc $(approx "$(secs_until "$LU")" 600) $(( $(j .count) - E0 ))"
call GET '/v1/inbox?unread=1' "$KM" ""; n=$(j .count)
call GET /v1/_ring_log "$KM" ""
row "9d muse drains its inbox: the poll does not lift a backoff lease" "2 same-lease" \
  "$n $([[ $(j .ring.lease_until) == "$LU" ]] && echo same-lease || echo "changed($(j .ring.lease_until))")"

# 10. Backoff + dead-letter: muse's doorbell -> <base>/v1/_echo with a WRONG secret (the echo answers 401 = failed).
#     Elapsed time is simulated by moving rings.lease_until into the past.
(cd "$ROOT" && node scripts/doorbell-set.mjs muse generic_webhook "$BASE/v1/_echo" "wrong-$RANDOM$RANDOM" "$MODE" >/dev/null 2>&1) \
  && ds=ok || ds=failed
call GET /v1/me "$KM" ""; dbs='.doorbell | "\(.kind) \(.state) \(.fail_count) \(.next_ring_after)"'
row "10a doorbell-set (wrong secret) also resets 9c's backoff" "ok generic_webhook ok 0 null" "$ds $(j "$dbs")"
ring_step() { # SUBJECT -> sets st (status http, newest first), dt (newest entry's detail), fc (fail_count), BODY = me as muse
  call GET /v1/_ring_log "$KM" ""; local l0; l0=$(j '.entries[0].id // 0')
  call POST /v1/send "$KC" "{\"to\":[\"muse\"],\"subject\":\"$1\",\"body\":\"x\"}"; sleep 3
  call GET /v1/_ring_log "$KM" ""; st=$(since_l0h "$l0"); fc=$(j .ring.fail_count); dt=$(j '.entries[0].detail')
  call GET /v1/me "$KM" ""
}
next_ring() { approx "$(secs_until "$(j .doorbell.next_ring_after)")" "$1"; }
ring_step "backoff 1"
row "10b ring answered 401: failed, detail http 401, fail_count 1, state backoff for ~10m" "failed 401 detail=http 401 1 backoff ~10m" \
  "$st detail=$dt $fc $(j .doorbell.state) $(next_ring 600)"
ring_step "backoff 2"
row "10c send inside the backoff: not rung (backoff, no http status)" "backoff null 1 backoff" "$st $fc $(j .doorbell.state)"
d1 "UPDATE rings SET lease_until = '$PAST' WHERE workspace_id = 'default' AND agent = 'muse'"
ring_step "backoff 3"
row "10d backoff elapsed: rung again, failed, fail_count 2, backoff ~20m" "failed 401 2 backoff ~20m" "$st $fc $(j .doorbell.state) $(next_ring 1200)"
d1 "UPDATE rings SET fail_count = 4, lease_until = '$PAST' WHERE workspace_id = 'default' AND agent = 'muse'"
ring_step "backoff 4"
row "10e fifth consecutive failure: dead" "failed 401 5 dead null" "$st $fc $(j .doorbell.state) $(j .doorbell.next_ring_after)"
d1 "UPDATE rings SET lease_until = '$PAST' WHERE workspace_id = 'default' AND agent = 'muse'"
ring_step "backoff 5"
row "10f dead, no lease left: dead_letter, nothing fetched" "dead_letter null 5 dead" "$st $fc $(j .doorbell.state)"
(cd "$ROOT" && node scripts/doorbell-set.mjs muse generic_webhook "$BASE/v1/_echo" "${ECHO_SECRET:-check-secret}" "$MODE" >/dev/null 2>&1) \
  && ds=ok || ds=failed
call GET /v1/_echo/hits "$KC" ""; E0=$(j .count)
ring_step "backoff 6"; s2="$(j .doorbell.state) $fc"
call GET /v1/_echo/hits "$KC" ""
row "10g doorbell-set (right secret) resets dead: next send rings ok, fail_count 0, echo +1" "ok ok 200 ok 0 1" "$ds $st $s2 $(( $(j .count) - E0 ))"
call GET '/v1/inbox?unread=1' "$KM" ""
d1 "UPDATE rings SET fail_count = 2, lease_until = '$PAST', in_flight_since = NULL WHERE workspace_id = 'default' AND agent = 'muse'"
ring_step "backoff 7"
row "10h after a backoff (fail_count 2), a 2xx ring resets fail_count by itself" "ok 200 0 ok" "$st $fc $(j .doorbell.state)"
call GET '/v1/inbox?unread=1' "$KM" ""

# 11. Waitlist (no key). Addresses @botline-check.invalid are never mailed (reserved TLD) and are deleted on exit, with
#     their rows in the waitlist_mail ledger (the mail counts both caps read; deleting a signup leaves them).
tok() { python3 -c 'import secrets; print(secrets.token_urlsafe(32))'; }
sha() { python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$1"; }
TODAY=$(date -u +%Y-%m-%d)
mails() { echo "(SELECT count FROM waitlist_mail WHERE workspace_id = 'default' AND day = '$TODAY' AND email_hash = '$(sha "$1")')"; } # SQL: today's mails to $1
WL="check-$(now_ms)@botline-check.invalid"; WLH+=("$(sha "$WL")")
call POST /v1/waitlist "" "{\"email\":\"$WL\",\"would_pay\":\"yes\",\"source\":\"check\"}"
row "11a signup" "202 accepted" "$STATUS $(j .status)"
call POST /v1/waitlist "" "{\"email\":\"$(tr '[:lower:]' '[:upper:]' <<<"$WL")\",\"would_pay\":\"maybe\"}"
row "11b same address again (upper case), same day: 202, still one row, new answer" "202 accepted 1 maybe" \
  "$STATUS $(j .status) $(d1q "SELECT COUNT(*) AS n, MAX(would_pay) AS w FROM waitlist WHERE email = '$WL'" '"\(.n) \(.w)"')"
wl_tok() { d1q "SELECT $(mails "$1") AS c, confirm_token_hash AS h FROM waitlist WHERE email = '$1'" '"\(.c) \(.h)"'; }
call POST /v1/waitlist "" "{\"email\":\"$WL\",\"would_pay\":\"yes\"}"; a=$STATUS; m3=$(wl_tok "$WL")
call POST /v1/waitlist "" "{\"email\":\"$WL\",\"would_pay\":\"no\"}"; m4=$(wl_tok "$WL")
row "11c third and fourth signup the same day: 202 both; the fourth is capped (no mail, tokens kept)" "202 202 3 capped" \
  "$a $STATUS ${m4%% *} $([[ $m4 == "$m3" ]] && echo capped || echo "changed(${m3%% *}->${m4%% *})")"
call POST /v1/waitlist "" '{"email":"not-an-address","would_pay":"yes"}'; a=$STATUS
call POST /v1/waitlist "" "{\"email\":\"$WL\",\"would_pay\":\"sure\"}"
row "11d bad email / bad would_pay" "400 / 400" "$a / $STATUS"
# The token path, tested directly: a row whose token hashes we know (the real links only reach the mail or the log).
CT=$(tok); DT=$(tok); WT="check-tok-$(now_ms)@botline-check.invalid"
d1 "INSERT INTO waitlist (workspace_id, email, would_pay, source, created_at, confirm_token_hash, delete_token_hash)
    VALUES ('default', '$WT', 'yes', 'check', '$(date -u +%Y-%m-%dT%H:%M:%SZ)', '$(sha "$CT")', '$(sha "$DT")')" && ins=ok || ins=failed
wl_conf() { d1q "SELECT confirmed_at FROM waitlist WHERE email = '$WT'" 'if .confirmed_at then "set" else "null" end'; }
call GET "/waitlist/confirm?t=$CT" "" ""
row "11e GET confirm link: one-button page, no-referrer, nothing confirmed yet" "ok 200 button no-referrer null" \
  "$ins $STATUS $(grep -qF '<form method="post" action="/waitlist/confirm">' "$TMP/body" && echo button || echo no-button) $(grep -qi '^referrer-policy: no-referrer' "$TMP/hdr" && echo no-referrer || echo referrer) $(wl_conf)"
call POST /waitlist/confirm "" "" --data-urlencode "t=$CT"
row "11f POST confirm: confirmed_at set" "200 set" "$STATUS $(wl_conf)"
call POST /v1/waitlist "" "{\"email\":\"$WT\",\"would_pay\":\"no\"}"
row "11g signup again for a confirmed address: 202, answer and tokens unchanged" "202 yes same-token" \
  "$STATUS $(d1q "SELECT would_pay, confirm_token_hash AS h FROM waitlist WHERE email = '$WT'" "\"\\(.would_pay) \\(if .h == \"$(sha "$CT")\" then \"same-token\" else \"new-token\" end)\"")"
call GET "/waitlist/delete?t=$DT" "" ""; a="$STATUS $(d1q "SELECT COUNT(*) AS n FROM waitlist WHERE email = '$WT'" .n)"
call POST /waitlist/delete "" "" --data-urlencode "t=$DT"
row "11h GET delete link (page only) / POST delete: row gone" "200 1 / 200 0" "$a / $STATUS $(d1q "SELECT COUNT(*) AS n FROM waitlist WHERE email = '$WT'" .n)"
call POST /waitlist/delete "" "" --data-urlencode "t=$DT"; a=$STATUS
call GET "/waitlist/confirm?t=not-a-token" "" ""
row "11i used delete link / malformed token" "404 / 404" "$a / $STATUS"
call GET '/waitlist?source=check' "" ""
row "11j GET /waitlist: price, question, privacy line, source carried" "200 price question privacy source" \
  "$STATUS $(grep -qF '$9/month' "$TMP/body" && echo price || echo no-price) $(grep -qF 'Would you pay this?' "$TMP/body" && echo question || echo no-question) $(grep -qF 'One confirmation email, one email if botline cloud launches, a delete link in both, nothing else; delete any time.' "$TMP/body" && echo privacy || echo no-privacy) $(grep -qF 'name="source" value="check"' "$TMP/body" && echo source || echo no-source)"
STRICT_CSP="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
row "11k Turnstile off (no TURNSTILE_* here): no external script, strict CSP; signups without a token pass (11a)" "no-script strict-csp" \
  "$(grep -qF 'challenges.cloudflare.com' "$TMP/body" && echo script || echo no-script) $(grep -qiF "content-security-policy: $STRICT_CSP" "$TMP/hdr" && echo strict-csp || echo other-csp)"
# Global daily mail cap: a filler ledger row stands in for the day's mails. Past the cap a signup still answers 202 and
# changes nothing: a new address gets no row, a pending one keeps its answer, mail count and tokens (its earlier link
# still works).
CAP=${WAITLIST_MAIL_CAP_PER_DAY:-80}; NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
WF="check-capfill-$(now_ms)@botline-check.invalid"; WP="check-cappend-$(now_ms)@botline-check.invalid"
WC="check-capnew-$(now_ms)@botline-check.invalid"; PT=$(tok); WLH+=("$(sha "$WF")" "$(sha "$WP")" "$(sha "$WC")")
d1 "INSERT INTO waitlist_mail (workspace_id, day, email_hash, count)
    VALUES ('default', '$TODAY', '$(sha "$WF")', $CAP), ('default', '$TODAY', '$(sha "$WP")', 1)" \
  && d1 "INSERT INTO waitlist (workspace_id, email, would_pay, created_at, confirm_token_hash, delete_token_hash)
    VALUES ('default', '$WP', 'maybe', '$NOW', '$(sha "$PT")', '$(sha "$(tok)")')" && ins=ok || ins=failed
call POST /v1/waitlist "" "{\"email\":\"$WP\",\"would_pay\":\"yes\"}"; a=$STATUS
call POST /v1/waitlist "" "{\"email\":\"$WC\",\"would_pay\":\"yes\"}"
row "11l past the daily cap ($CAP mails): pending address unchanged / new address not stored" "ok 202 maybe 1 same-token / 202 0" \
  "$ins $a $(d1q "SELECT would_pay, $(mails "$WP") AS c, confirm_token_hash AS h FROM waitlist WHERE email = '$WP'" "\"\\(.would_pay) \\(.c) \\(if .h == \"$(sha "$PT")\" then \"same-token\" else \"new-token\" end)\"") / $STATUS $(d1q "SELECT COUNT(*) AS n FROM waitlist WHERE email = '$WC'" .n)"
d1 "DELETE FROM waitlist_mail WHERE workspace_id = 'default' AND day = '$TODAY' AND email_hash = '$(sha "$WF")'"
call POST /v1/waitlist "" "{\"email\":\"$WC\",\"would_pay\":\"yes\"}"
row "11m filler gone (under the cap again): the new address is stored with one mail" "202 1 1" \
  "$STATUS $(d1q "SELECT COUNT(*) AS n, $(mails "$WC") AS m FROM waitlist WHERE email = '$WC'" '"\(.n) \(.m)"')"
# Turnstile on: a second deployment of the same code with TURNSTILE_SECRET + TURNSTILE_SITE_KEY set (locally a second
# `wrangler dev`, see README). Only paths that never reach Cloudflare's siteverify: no token, an oversized token.
TSB=${BOTLINE_TURNSTILE_BASE:-}; TSB=${TSB%/}; TS_NOTE="turnstile-on rows: skipped (BOTLINE_TURNSTILE_BASE unset)"
if [[ -n $TSB ]]; then
  TS_NOTE="turnstile-on rows: $TSB"
  SAVE=$BASE; BASE=$TSB
  call GET /waitlist "" ""
  row "11n Turnstile on: /waitlist loads the widget; CSP allows only challenges.cloudflare.com for script and frame" \
    "200 script widget ts-csp" "$STATUS $(grep -qF '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>' "$TMP/body" && echo script || echo no-script) $(grep -qF 'class="cf-turnstile" data-sitekey="' "$TMP/body" && echo widget || echo no-widget) $(grep -qiF "content-security-policy: default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline';" "$TMP/hdr" && echo ts-csp || echo other-csp)"
  call POST /v1/waitlist "" "{\"email\":\"ts-$(now_ms)@botline-check.invalid\",\"would_pay\":\"yes\"}"; a="$STATUS $(j .error)"
  call POST /v1/waitlist "" "" -H 'content-type: application/x-www-form-urlencoded' --data "email=ts-form@botline-check.invalid&would_pay=yes"; b=$STATUS
  call POST /v1/waitlist "" "{\"email\":\"ts-long@botline-check.invalid\",\"would_pay\":\"yes\",\"cf-turnstile-response\":\"$(printf 'x%.0s' {1..2049})\"}"
  row "11o Turnstile on: JSON without token / form without token / token over 2048 chars" \
    "400 captcha_failed / 400 / 400 captcha_failed" "$a / $b / $STATUS $(j .error)"
  BASE=$SAVE
else
  echo "note: $TS_NOTE" >&2
fi
# Deleting a signup does not reset its mail count (the ledger keeps it): sign up, delete with the link (a delete token we
# know, set with SQL), three times; the fourth signup the same day is capped: 202, no row, still 3 mails counted.
# The rows above used up the per-IP bucket (10 signups, +1 every 6 s): a 429 here is waited out, up to 3 times.
WX="check-del-$(now_ms)@botline-check.invalid"; WLH+=("$(sha "$WX")"); sx=""; dx=""
wx_signup() { local n; for n in 1 2 3 4; do call POST /v1/waitlist "" "{\"email\":\"$WX\",\"would_pay\":\"yes\"}"; [[ $STATUS == 429 && $n -lt 4 ]] || return 0; sleep 7; done; }
for _ in 1 2 3; do
  wx_signup; sx="$sx $STATUS"
  XT=$(tok); d1 "UPDATE waitlist SET delete_token_hash = '$(sha "$XT")' WHERE workspace_id = 'default' AND email = '$WX'"
  call POST /waitlist/delete "" "" --data-urlencode "t=$XT"; dx="$dx $STATUS"
done
wx_signup
row "11p sign up + delete, three times; a fourth signup is capped by the ledger: 202, no row, 3 mails" "202 202 202 / 200 200 200 / 202 0 3" \
  "${sx# } / ${dx# } / $STATUS $(d1q "SELECT COUNT(*) AS n, $(mails "$WX") AS c FROM waitlist WHERE email = '$WX'" '"\(.n) \(.c)"')"

# 12. Table
echo "| step | expected | actual | result |"
echo "|---|---|---|---|"
printf '%s\n' "${ROWS[@]}"
echo
echo "steps: ${#ROWS[@]}  failed: $FAILS  base: $BASE  $TS_NOTE  at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ $FAILS -eq 0 ]]
