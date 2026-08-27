#!/usr/local/bin/bash
# Fixture tests for Graphify Viewer status API.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SCRIPT_DIR/../server.js"

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); printf 'ok %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
finish() {
  printf '%s: %d passed, %d failed\n' "$(basename "$0")" "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/graphify-viewer-test.XXXXXX")"
PORT=4400
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

next_port() {
  PORT=$((PORT + 1))
}

start_server() {
  local store_dir="$1"
  GRAPHIFY_STORE_DIR="$store_dir" GRAPHIFY_VIEWER_PORT="$PORT" \
    nohup bun "$SERVER" >"$ROOT/server.log" 2>&1 &
  local pid=$!
  local waited=0
  while ! curl -s "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && [ "$waited" -lt 20 ]; do
    sleep 0.5; waited=$((waited + 1))
  done
  echo "$pid"
}

stop_server() {
  local pid="$1"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
  sleep 0.5  # Allow port release.
}

create_fixture() {
  local store="$1" tag="$2" head="$3" dirty="${4:-false}"
  local repo="$store/repos/$tag/graphify-out"
  local gen="$store/generations/$tag/current"
  mkdir -p "$repo" "$gen"
  printf '{"nodes":[{"id":"a"}],"links":[]}' >"$repo/graph.json"
  printf '<html>graph</html>' >"$repo/graph.html"
  printf '<html>tree</html>' >"$repo/GRAPH_TREE.html"
  printf '# report\n' >"$repo/GRAPH_REPORT.md"
  python3 -c "
import json, hashlib, os
arts = {}
for n in ('graph.json','graph.html','GRAPH_TREE.html','GRAPH_REPORT.md'):
    d = open(os.path.join('$repo',n),'rb').read()
    arts[n] = {'sha256':hashlib.sha256(d).hexdigest(),'bytes':len(d)}
m = {'schema':'graphify-generation/v1','tag':'$tag','generation_id':'gen-test',
     'mode':'semantic','head':'$head',
     'working_tree_dirty': $( [ "$dirty" = "true" ] && echo "True" || echo "False" ),
     'content_fingerprint':'fp','observed_at':'2026-08-25T12:00:00Z','artifacts':arts}
json.dump(m, open('$gen/generation.json','w'), indent=2)
"
  mkdir -p "$(dirname "$store/global-manifest.json")"
  python3 -c "
import json, os
mf = '$store/global-manifest.json'
r = {'$tag':{'source_path':'$repo/graph.json','node_count':10,'edge_count':5,'added_at':'2026-08-25T12:00:00Z'}}
if os.path.exists(mf):
    e = json.load(open(mf)); e.setdefault('repos',{}).update(r); r = e
json.dump({'repos':r} if 'repos' not in r else r, open(mf,'w'))
"
}

# --- Test 1: status returns typed envelopes ---
next_port
STORE="$ROOT/t1"; mkdir -p "$STORE"
create_fixture "$STORE" "repo-a" "abc123" "false"
PID=$(start_server "$STORE")
RESP=$(curl -s "http://127.0.0.1:$PORT/api/status")
N=$(echo "$RESP" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')
[ "$N" -eq 1 ] && ok "status: returns 1 item" || fail "status: returns 1 item"
echo "$RESP" | grep -q '"snapshot"' && ok "status: has snapshot" || fail "status: has snapshot"
echo "$RESP" | grep -q '"update_scope"' && ok "status: has update_scope" || fail "status: has update_scope"
echo "$RESP" | grep -q '"last_checked"' && ok "status: has last_checked" || fail "status: has last_checked"
# Verify envelope shape.
echo "$RESP" | python3 -c '
import json,sys
i = json.load(sys.stdin)["items"][0]
for k in ("item","status","can_update","update_scope","last_checked","details","job"):
    assert k in i, f"missing {k}"
assert i["item"]["id"] and i["item"]["label"], "empty id/label"
assert i["status"] in ("current","stale","missing","failed","unknown"), f"bad status {i['status']}"
' && ok "status: envelope shape valid" || fail "status: envelope shape valid"
stop_server "$PID"

# --- Test 2: missing generation → missing ---
next_port
STORE="$ROOT/t2"; mkdir -p "$STORE"
REPO="$STORE/repos/nogen/graphify-out"; mkdir -p "$REPO"
printf '{"nodes":[],"links":[]}' >"$REPO/graph.json"
printf '<html></html>' >"$REPO/graph.html"
printf '<html></html>' >"$REPO/GRAPH_TREE.html"
printf '# r' >"$REPO/GRAPH_REPORT.md"
python3 -c "
import json
json.dump({'repos':{'nogen':{'source_path':'$REPO/graph.json','node_count':0,'edge_count':0,'added_at':'2026-08-25'}}}, open('$STORE/global-manifest.json','w'))
"
PID=$(start_server "$STORE")
RESP=$(curl -s "http://127.0.0.1:$PORT/api/status")
echo "$RESP" | python3 -c '
import json,sys
i = json.load(sys.stdin)["items"][0]
assert i["status"]=="unknown", f"expected unknown got {i['status']}"
assert i["reason"]["code"]=="graphify/no_generation_record"
' && ok "missing: no_generation reason" || fail "missing: no_generation reason"
stop_server "$PID"

# --- Test 3: missing artifact → missing ---
next_port
STORE="$ROOT/t3"; mkdir -p "$STORE"
create_fixture "$STORE" "partial" "abc123" "false"
rm -f "$STORE/repos/partial/graphify-out/GRAPH_TREE.html"
PID=$(start_server "$STORE")
RESP=$(curl -s "http://127.0.0.1:$PORT/api/status")
echo "$RESP" | python3 -c '
import json,sys
i = json.load(sys.stdin)["items"][0]
assert i["status"]=="missing"
assert i["reason"]["code"]=="graphify/artifacts_missing"
' && ok "missing-art: reason is missing_artifacts" || fail "missing-art: reason is missing_artifacts"
stop_server "$PID"

# --- Test 4: snapshot structure ---
next_port
STORE="$ROOT/t4"; mkdir -p "$STORE"
create_fixture "$STORE" "snap" "abc123" "false"
PID=$(start_server "$STORE")
SNAP=$(curl -s "http://127.0.0.1:$PORT/api/snapshot")
echo "$SNAP" | python3 -c '
import json,sys
s = json.load(sys.stdin)
for k in ("snapshot","observed_at","expires_at","ttl_ms","items","capabilities"):
    assert k in s, f"missing {k}"
assert len(s["items"])==1
i = s["items"][0]
for k in ("id","label","status","reason","generated","current","details"):
    assert k in i, f"item missing {k}"
' && ok "snapshot: structure valid" || fail "snapshot: structure valid"
stop_server "$PID"

# --- Test 5: no paths leak ---
next_port
STORE="$ROOT/t5"; mkdir -p "$STORE"
create_fixture "$STORE" "noleak" "abc123" "false"
PID=$(start_server "$STORE")
STATUS_RAW=$(curl -s "http://127.0.0.1:$PORT/api/status")
SNAP_RAW=$(curl -s "http://127.0.0.1:$PORT/api/snapshot")
echo "$STATUS_RAW" | grep -q '/Users/' && fail "no-paths: /Users/ in status" || ok "no-paths: no /Users/ in status"
echo "$SNAP_RAW" | grep -q '/Users/' && fail "no-paths: /Users/ in snapshot" || ok "no-paths: no /Users/ in snapshot"
echo "$STATUS_RAW" | grep -q '/tmp/' && fail "no-paths: /tmp/ in status" || ok "no-paths: no /tmp/ in status"
echo "$SNAP_RAW" | grep -q '/tmp/' && fail "no-paths: /tmp/ in snapshot" || ok "no-paths: no /tmp/ in snapshot"
stop_server "$PID"

# --- Test 6: healthz still works ---
next_port
STORE="$ROOT/t6"; mkdir -p "$STORE"
PID=$(start_server "$STORE")
HZ=$(curl -s "http://127.0.0.1:$PORT/healthz")
echo "$HZ" | grep -q '"ok":true' && ok "healthz: ok=true" || fail "healthz: ok=true (got: $HZ)"
stop_server "$PID"

# --- Test 7: picker still works ---
next_port
STORE="$ROOT/t7"; mkdir -p "$STORE"
create_fixture "$STORE" "picker" "abc123" "false"
PID=$(start_server "$STORE")
HTML=$(curl -s "http://127.0.0.1:$PORT/")
echo "$HTML" | grep -q 'Graphify Viewer' && ok "picker: title present" || fail "picker: title present"
echo "$HTML" | grep -q '<!DOCTYPE html>' && ok "picker: is HTML" || fail "picker: is HTML"
stop_server "$PID"

# --- Test 8: dirty working tree → current with warning ---
next_port
STORE="$ROOT/t8"; mkdir -p "$STORE"
# Create a real git repo so HEAD matches.
REPO_ROOT="$ROOT/t8-repo"
mkdir -p "$REPO_ROOT/graphify-out"
git -C "$REPO_ROOT" init -q
git -C "$REPO_ROOT" commit --allow-empty -q -m "init"
HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD)
printf '{"nodes":[],"links":[]}' >"$REPO_ROOT/graphify-out/graph.json"
printf '<html></html>' >"$REPO_ROOT/graphify-out/graph.html"
printf '<html></html>' >"$REPO_ROOT/graphify-out/GRAPH_TREE.html"
printf '# r' >"$REPO_ROOT/graphify-out/GRAPH_REPORT.md"
# Create dirty working tree.
echo "dirty" > "$REPO_ROOT/graphify-out/dirty.txt"
# Create generation matching HEAD.
GEN_DIR="$STORE/generations/dirty-test/current"
mkdir -p "$GEN_DIR"
python3 -c "
import json, hashlib, os
repo='$REPO_ROOT/graphify-out'
arts={}
for n in ('graph.json','graph.html','GRAPH_TREE.html','GRAPH_REPORT.md'):
    d=open(os.path.join(repo,n),'rb').read()
    arts[n]={'sha256':hashlib.sha256(d).hexdigest(),'bytes':len(d)}
json.dump({'schema':'graphify-generation/v1','tag':'dirty-test','generation_id':'gen-d',
           'mode':'semantic','head':'$HEAD','working_tree_dirty':False,
           'content_fingerprint':'fp','observed_at':'2026-08-25T12:00:00Z','artifacts':arts},
          open('$GEN_DIR/generation.json','w'),indent=2)
"
python3 -c "
import json
json.dump({'repos':{'dirty-test':{'source_path':'$REPO_ROOT/graphify-out/graph.json','node_count':0,'edge_count':0,'added_at':'2026-08-25'}}}, open('$STORE/global-manifest.json','w'))
"
PID=$(start_server "$STORE")
RESP=$(curl -s "http://127.0.0.1:$PORT/api/status")
echo "$RESP" | python3 -c '
import json,sys
i = json.load(sys.stdin)["items"][0]
assert i["status"]=="current", f"expected current got {i['status']}"
assert i["reason"]["code"]=="graphify/working_tree_dirty"
assert i["details"].get("working_tree_dirty")==True
' && ok "dirty: current with working_tree_dirty warning" || fail "dirty: current with working_tree_dirty warning"
stop_server "$PID"

finish
