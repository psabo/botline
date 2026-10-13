#!/usr/bin/env bash
# Self-test for scripts/conformance.mjs against a LOCAL botline (wrangler dev --local), the three agents simulated by
# scripts/conformance-sim.mjs. The simulator reads the agents' inboxes, so this refuses any non-local base.
#   scripts/conformance-selftest.sh <base_url> <key_claude> <key_grokbot> <key_muse>
# Env as for check.sh: ECHO_SECRET (= the Worker's; grokbot's doorbell points at <base>/v1/_echo during the test and is
# reset to `none` on exit, so the "ring accepted" column is exercised), DOORBELL_MASTER_KEY, BOTLINE_PERSIST_TO.
# Four runs: (1) all agents simulated, --relay: exit 0, six PASS, relay PASS with the body unchanged, rung pings show an
# accepted time, the rings counted per recipient match its ring log; (2) the same --run-id again: exit 0 and not one new
# message (resume); (3) muse silent (never polls, never replies), 15 s timeout: exit 1, the two pings to muse FAIL as
# "never read", the other four PASS, and muse's two pings are still unread afterwards (conformance.mjs claimed nothing);
# (4) a slow server (the simulator's front holds each thread read 10 s) and a late muse (answers 19 s after reading),
# 15 s timeout: exit 1, muse's two pairs FAIL as "replied late", the run ends within the timeout + 30 s.
# Prints a table, then the output of runs 1 and 4; exit 1 on a FAIL.
set -uo pipefail
BASE=${1:?usage: conformance-selftest.sh <base_url> <key_claude> <key_grokbot> <key_muse>}
KC=${2:?key_claude}; KG=${3:?key_grokbot}; KM=${4:?key_muse}; BASE=${BASE%/}
[[ $BASE =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] || { echo "conformance-selftest.sh plays the agents: local bases only" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); ROWS=(); FAILS=0; SIM=""
export BOTLINE_AGENTS=claude,grokbot,muse BOTLINE_KEY_CLAUDE=$KC BOTLINE_KEY_GROKBOT=$KG BOTLINE_KEY_MUSE=$KM
cleanup() {
  [[ -n $SIM ]] && kill "$SIM" 2>/dev/null
  (cd "$ROOT" && node scripts/doorbell-set.mjs grokbot none - --local >/dev/null 2>&1) \
    || echo "warning: cleanup: grokbot's doorbell was not reset: node scripts/doorbell-set.mjs grokbot none - --local" >&2
  rm -rf "$TMP"
}
trap cleanup EXIT
row() { local st=FAIL; [[ "$2" == "$3" ]] && st=PASS; [[ $st == FAIL ]] && FAILS=$((FAILS + 1)); ROWS+=("| $1 | $2 | $3 | $st |"); }
PERSIST=(); [[ -n ${BOTLINE_PERSIST_TO:-} ]] && PERSIST=(--persist-to "$BOTLINE_PERSIST_TO")
d1q() {
  (cd "$ROOT" && npx wrangler d1 execute "${BOTLINE_DB:-botline-spike}" --local ${PERSIST[@]+"${PERSIST[@]}"} --command "$1" --yes --json 2>/dev/null) \
    | sed -n '/^\[/,$p' | jq -r ".[-1].results[0] | $2" 2>/dev/null
}
inbox() { curl -sS "$BASE/v1/inbox?unread=1" -H "authorization: Bearer $1"; } # as that agent: claims its unread mail
drain() { for k in "$KC" "$KG" "$KM"; do inbox "$k" >/dev/null; done; }
sim_start() { node "$ROOT/scripts/conformance-sim.mjs" "$BASE" --interval-ms 500 "$@" >"$TMP/sim.out" 2>>"$TMP/sim.log" & SIM=$!; }
sim_stop() { kill "$SIM" 2>/dev/null; wait "$SIM" 2>/dev/null; SIM=""; }
conf() { node "$ROOT/scripts/conformance.mjs" "$BASE" --poll-sec 2 "$@"; }
pairs() { grep -cE '^- [a-z]+ -> [a-z]+: '"$1" "$2"; }
rings() { sed -n '/^### Doorbell rings/,$p' "$1" | awk -F'|' -v a="$2" '{ gsub(/ /, "", $2) } $2 == a { split($4, x, " "); print x[1] }'; }

drain
(cd "$ROOT" && node scripts/doorbell-set.mjs grokbot generic_webhook "$BASE/v1/_echo" "${ECHO_SECRET:-check-secret}" --local >/dev/null 2>&1) \
  && ds=ok || ds=failed
row "0 grokbot's doorbell -> <base>/v1/_echo for the test" "ok" "$ds"

# 1. Everyone answers.
RUN="selftest-$(date -u +%Y%m%dT%H%M%SZ)"
sim_start
conf --relay --timeout-min 2 --run-id "$RUN" >"$TMP/run1.md" 2>"$TMP/run1.err"; e=$?
row "1a all agents simulated, --relay: exit code" "0" "$e"
row "1b verdicts" "6 PASS 0 FAIL" "$(pairs PASS "$TMP/run1.md") PASS $(pairs FAIL "$TMP/run1.md") FAIL"
row "1c relay verdict" "PASS body-unchanged" \
  "$(grep -q '^- relay: PASS: loop closed' "$TMP/run1.md" && echo PASS || echo FAIL) $(grep -q 'body unchanged across 3 relay hops' "$TMP/run1.md" && echo body-unchanged || echo body-?)"
row "1d relay table: hops 0-3 (claude -> grokbot -> muse -> claude, then claude's reply to muse)" \
  "0 claude -> grokbot,1 grokbot -> muse,2 muse -> claude,3 claude -> muse" \
  "$(grep -oE '^\| [0-9] [a-z]+ -> [a-z]+ ' "$TMP/run1.md" | sed 's/^| //; s/ $//' | paste -sd, -)"
row "1e pings to grokbot (doorbell): ring ok 200 with an accepted time on >= 1; pings to the poll agents: no_doorbell, -" "yes 4" \
  "$(grep -qE "^\| $RUN \| [a-z]+ -> grokbot \| generic_webhook \| ok 200 \| [0-9:]+Z \| [0-9]+:[0-9]{2}:[0-9]{2} \|" "$TMP/run1.md" && echo yes || echo no) $(grep -cE "^\| $RUN \| [a-z]+ -> (claude|muse) \| none \| no_doorbell \| [0-9:]+Z \| - \|" "$TMP/run1.md")"
like="subject LIKE '%conformance % $RUN %' OR subject LIKE '%conformance relay $RUN'"
g=$(rings "$TMP/run1.md" grokbot)
gd=$(d1q "SELECT COUNT(*) AS n FROM ring_log l WHERE l.agent = 'grokbot' AND l.status IN ('ok','failed','timeout') AND EXISTS
  (SELECT 1 FROM json_each(l.message_ids) j JOIN messages m ON m.id = j.value WHERE m.thread_id IN (SELECT thread_id FROM messages WHERE $like))" .n)
row "1f rings per recipient: claude, muse (no doorbell) 0; grokbot 1-5, equal to its ring_log rows for the run's threads" "0 0 in-range equal" \
  "$(rings "$TMP/run1.md" claude) $(rings "$TMP/run1.md" muse) $([[ $g =~ ^[0-9]+$ ]] && (( g >= 1 && g <= 5 )) && echo in-range || echo "out-of-range($g)") $([[ $g == "$gd" ]] && echo equal || echo "differ($g/$gd)")"
row "1g the note before sending states grokbot's worst case (2 + 2 + 1)" "stated" \
  "$(grep -qF 'Worst case for this run: grokbot (generic_webhook) 5 rings.' "$TMP/run1.err" && echo stated || echo missing)"

# 2. Resume: the same run id sends nothing new.
n0=$(d1q "SELECT COUNT(*) AS n FROM messages WHERE $like" .n)
conf --relay --timeout-min 1 --run-id "$RUN" >"$TMP/run2.md" 2>"$TMP/run2.err"; e=$?
n1=$(d1q "SELECT COUNT(*) AS n FROM messages WHERE $like" .n)
row "2 the same --run-id again: exit 0, 6 PASS, relay PASS, message count unchanged (16)" "0 6 PASS 16 16" \
  "$e $(pairs PASS "$TMP/run2.md") $(grep -q '^- relay: PASS' "$TMP/run2.md" && echo PASS || echo FAIL) $n0 $n1"
sleep 1; sim_stop; drain

# 3. Muse never answers: its pings time out, and conformance.mjs leaves them unread.
sim_start --silent muse
conf --timeout-min 0.25 --run-id "$RUN-silent" >"$TMP/run3.md" 2>"$TMP/run3.err"; e=$?
sim_stop
row "3a muse silent, 15 s timeout: exit code" "1" "$e"
row "3b verdicts: 4 PASS; claude -> muse and grokbot -> muse FAIL, never read" "4 2 claude,grokbot" \
  "$(pairs PASS "$TMP/run3.md") $(pairs 'FAIL: no reply within 15 s: never read' "$TMP/run3.md") $(grep -oE '^- [a-z]+ -> muse: FAIL' "$TMP/run3.md" | awk '{print $2}' | sort | paste -sd, -)"
row "3c muse's two pings are still unread (nothing claimed them)" "2" \
  "$(inbox "$KM" | jq --arg r "$RUN-silent" '[.messages[] | select(.subject | startswith("conformance ping \($r) "))] | length')"
drain

# 4. A slow server and a late agent: the simulator's front holds every thread read 10 s, muse answers 19 s after reading,
#    the timeout is 15 s. conformance.mjs must start no poll after the deadline, cut the one in flight, count only
#    replies stamped by the deadline, and end within the timeout + 30 s. (Polling a full round before checking the
#    deadline, six reads x 10 s, would see muse's replies and pass after about a minute.)
sim_start --slow muse=19 --front-delay-ms 10000
FRONT=""
for _ in $(seq 50); do FRONT=$(sed -n 's/^front //p' "$TMP/sim.out" 2>/dev/null); [[ -n $FRONT ]] && break; sleep 0.1; done
s0=$SECONDS
node "$ROOT/scripts/conformance.mjs" "${FRONT:-http://127.0.0.1:9}" --poll-sec 2 --timeout-min 0.25 --run-id "$RUN-late" >"$TMP/run4.md" 2>"$TMP/run4.err"; e=$?
el=$((SECONDS - s0))
sim_stop; drain
row "4a slow server (thread reads +10 s), muse answers after 19 s, 15 s timeout: exit code" "1" "$e"
row "4b verdicts: 4 PASS; claude -> muse and grokbot -> muse FAIL, replied late" "4 2 claude,grokbot" \
  "$(pairs PASS "$TMP/run4.md") $(pairs 'FAIL: replied late: [0-9:]+ \(after the 15 s timeout\)' "$TMP/run4.md") $(grep -oE '^- [a-z]+ -> muse: FAIL' "$TMP/run4.md" | awk '{print $2}' | sort | paste -sd, -)"
row "4c wall time within the timeout + 30 s (took $el s)" "<= 45 s" "$( (( el <= 45 )) && echo '<= 45 s' || echo "${el} s")"

row "5 no key in any output (bl_<8>_<32>)" "0" \
  "$(cat "$TMP"/run*.md "$TMP"/run*.err "$TMP/sim.log" "$TMP/sim.out" | grep -cE 'bl_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}')"

echo "| step | expected | actual | result |"
echo "|---|---|---|---|"
printf '%s\n' "${ROWS[@]}"
echo
echo "steps: ${#ROWS[@]}  failed: $FAILS  base: $BASE  run: $RUN  at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
cat "$TMP/run1.md"
echo
cat "$TMP/run4.md"
[[ $FAILS -eq 0 ]]
