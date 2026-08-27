#!/usr/bin/env bash
# Fixture producer: behavior-switchable stand-in for graphify-refresh.sh.
# Reads behavior word from $FAKE_BEHAVIOR_FILE ("", "hang", "busy", "failall").
# Emits exact versioned JSONL result events into
# $GRAPHIFY_STORE_DIR/results/graphify-refresh-results.jsonl using base64
# payloads (shell-inert) with a __TAG__ placeholder replaced per tag.
set -u

behavior=""
[ -f "${FAKE_BEHAVIOR_FILE:-}" ] && behavior=$(cat "${FAKE_BEHAVIOR_FILE}")

mkdir -p "${GRAPHIFY_STORE_DIR}/results"
out="${GRAPHIFY_STORE_DIR}/results/graphify-refresh-results.jsonl"

tags=()
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  if [ "${args[$i]}" = "--tag" ]; then
    tags+=("${args[$((i + 1))]}")
    i=$((i + 2))
  else
    i=$((i + 1))
  fi
done
if [ "${#tags[@]}" -eq 0 ]; then
  IFS="," read -ra tags <<< "${FAKE_ALL_TAGS:-alpha}"
fi

EV_UPD='eyJzY2hlbWEiOiJncmFwaGlmeS1yZWZyZXNoLXJlc3VsdC92MSIsInRhZyI6Il9fVEFHX18iLCJvdXRjb21lIjoidXBkYXRlZCIsImdlbmVyYXRpb25faWQiOiJnZW4tX19UQUdfXy1uZXciLCJtZXNzYWdlIjoiZ2VuZXJhdGlvbiBwdWJsaXNoZWQifQ=='
EV_FAIL='eyJzY2hlbWEiOiJncmFwaGlmeS1yZWZyZXNoLXJlc3VsdC92MSIsInRhZyI6Il9fVEFHX18iLCJvdXRjb21lIjoiZmFpbGVkIiwiZ2VuZXJhdGlvbl9pZCI6Imdlbi1fX1RBR19fLW5ldyIsIm1lc3NhZ2UiOiJleHRyYWN0IHJjPTEifQ=='
EV_BUSY='eyJzY2hlbWEiOiJncmFwaGlmeS1yZWZyZXNoLXJlc3VsdC92MSIsInRhZyI6Ii0iLCJvdXRjb21lIjoiYnVzeSIsImdlbmVyYXRpb25faWQiOm51bGwsIm1lc3NhZ2UiOiJyZWZyZXNoIGxvY2sgaGVsZCBieSBwaWQgMTIzNDUifQ=='

if [ "$behavior" = "busy" ]; then
  printf '%s' "$EV_BUSY" | base64 -D >>"$out"
  printf '\n' >>"$out"
  exit 2
fi

for tag in "${tags[@]}"; do
  ev="$EV_UPD"
  if [ "$behavior" = "failall" ]; then
    ev="$EV_FAIL"
  fi
  printf '%s' "$ev" | base64 -D | sed "s/__TAG__/$tag/g" >>"$out"
  printf '\n' >>"$out"
done

if [ "$behavior" = "hang" ]; then
  trap 'exit 143' TERM
  sleep 28800 &
  wait $!
fi
exit 0
