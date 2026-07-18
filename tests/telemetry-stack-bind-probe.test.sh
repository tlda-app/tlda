#!/usr/bin/env bash
# Regression test: the Grafana bind address (GF_SERVER_HTTP_ADDR) and the
# readiness-probe address in start_grafana must always be the same value.
# They previously drifted apart (bind on the validated Tailscale-only
# address, probe hardcoded to 127.0.0.1) which made a *correct* secure
# start report failed after the 60s readiness timeout.
#
# Full isolation: the real telemetry/stack.sh is copied into a fresh temp
# directory (preserving its telemetry/ subpath, since the script derives
# all of its own working paths — $ROOT, $STACK_DIR, $BIN_DIR, etc. — from
# its own location via $BASH_SOURCE). Sourcing the copy from there means
# every path stack.sh itself creates (including the `mkdir -p` at module
# load) lands inside the temp directory, never in the real repo or in a
# shared/predictable path like /tmp/grafana.log. The temp directory is
# removed on exit regardless of outcome (trap, not a bare cleanup at the
# end that a failure could skip).
#
# Usage: bash tests/telemetry-stack-bind-probe.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/telemetry"
cp "$REPO_ROOT/telemetry/stack.sh" "$WORKDIR/telemetry/stack.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- Test 1: sourcing must not dispatch a subcommand or leak the real
#     script's directories outside the isolated temp copy. ---
# shellcheck disable=SC1091
source "$WORKDIR/telemetry/stack.sh"
[[ "$STACK_DIR" == "$WORKDIR"/* ]] || fail "STACK_DIR ($STACK_DIR) escaped the isolated temp directory"
[[ -d "$STACK_DIR" ]] || fail "expected stack.sh's own module-load mkdir to have created $STACK_DIR inside the temp copy"
echo "PASS: sourced in isolation — STACK_DIR is fully contained in $WORKDIR, no dispatch fired"

# --- Test 2: wildcard/LAN GRAFANA_HOST override is rejected. ---
if ( GRAFANA_HOST=0.0.0.0 resolve_tailscale_bind_host ) >/dev/null 2>&1; then
  fail "GRAFANA_HOST=0.0.0.0 was accepted — wildcard/LAN bind escape regressed"
fi
echo "PASS: GRAFANA_HOST=0.0.0.0 is rejected"

# --- Test 3: a .ts.net public hostname must obtain the certificate through
#     the existing cert/key authority, validate it, and force HTTPS before
#     Grafana is started or its URL is advertised. ---
TLS_CAPTURE="$WORKDIR/tls-capture"
(
  set -euo pipefail
  GRAFANA_PUBLIC_HOST="test-machine.example.ts.net"
  GRAFANA_CERT_FILE="$WORKDIR/certs/test.crt"
  GRAFANA_CERT_KEY="$WORKDIR/certs/test.key"
  GRAFANA_PROTOCOL=http
  have() { [[ "$1" == tailscale ]]; }
  tailscale() {
    printf '%s\n' "$*" > "$TLS_CAPTURE"
    printf 'mock cert' > "$GRAFANA_CERT_FILE"
    printf 'mock key' > "$GRAFANA_CERT_KEY"
  }
  validate_grafana_cert() { [[ -s "$GRAFANA_CERT_FILE" && -s "$GRAFANA_CERT_KEY" ]]; }
  prepare_grafana_protocol
  [[ "$GRAFANA_PROTOCOL" == https ]] || fail ".ts.net hostname did not force HTTPS"
  [[ "$GRAFANA_URL" == https://test-machine.example.ts.net:* ]] || fail "advertised URL was not refreshed to HTTPS"
)
TLS_ARGS="$(cat "$TLS_CAPTURE")"
[[ "$TLS_ARGS" == *"--cert-file $WORKDIR/certs/test.crt"* ]] || fail "tailscale cert did not receive the authoritative cert path"
[[ "$TLS_ARGS" == *"--key-file $WORKDIR/certs/test.key"* ]] || fail "tailscale cert did not receive the authoritative key path"
[[ "$TLS_ARGS" == *"test-machine.example.ts.net" ]] || fail "tailscale cert did not receive the public hostname"
echo "PASS: .ts.net hostname obtains its Tailscale certificate and requires HTTPS"

# --- Test 4: the real certificate validator requires an exact discrete DNS
#     SAN and a matching private key. Generated fixtures keep this isolated
#     from Tailscale and from the machine certificate store. ---
VALIDATOR_DIR="$WORKDIR/validator"
mkdir -p "$VALIDATOR_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=exact.example.ts.net' \
  -addext 'subjectAltName=DNS:exact.example.ts.net' \
  -keyout "$VALIDATOR_DIR/exact.key" -out "$VALIDATOR_DIR/exact.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=exact.example.ts.net.evil.example' \
  -addext 'subjectAltName=DNS:exact.example.ts.net.evil.example' \
  -keyout "$VALIDATOR_DIR/lookalike.key" -out "$VALIDATOR_DIR/lookalike.crt" >/dev/null 2>&1

GRAFANA_PUBLIC_HOST=exact.example.ts.net
GRAFANA_CERT_FILE="$VALIDATOR_DIR/exact.crt"
GRAFANA_CERT_KEY="$VALIDATOR_DIR/exact.key"
validate_grafana_cert

if ( GRAFANA_CERT_FILE="$VALIDATOR_DIR/lookalike.crt" GRAFANA_CERT_KEY="$VALIDATOR_DIR/lookalike.key" validate_grafana_cert ) >/dev/null 2>&1; then
  fail "lookalike SAN exact.example.ts.net.evil.example passed exact-host validation"
fi
if ( GRAFANA_CERT_FILE="$VALIDATOR_DIR/exact.crt" GRAFANA_CERT_KEY="$VALIDATOR_DIR/lookalike.key" validate_grafana_cert ) >/dev/null 2>&1; then
  fail "certificate passed with a mismatched private key"
fi
echo "PASS: real validator accepts exact SAN only and rejects lookalike SANs and mismatched keys"

# --- Test 5: start_grafana must hand the exact same resolved address to
#     both GF_SERVER_HTTP_ADDR and the readiness-probe URL. Every
#     side-effecting dependency (resolver, admin-secret check, binary
#     lookup, pid tracking, spawn, health probe) is stubbed inside a
#     subshell so the real start_grafana body runs with zero network
#     access, zero process spawns, and zero writes outside $WORKDIR. ---
BIND_CAPTURE="$WORKDIR/bind-capture"
PROBE_CAPTURE="$WORKDIR/probe-capture"
set +e
(
  set -euo pipefail
  resolve_tailscale_bind_host() { echo "100.99.99.99"; }
  prepare_grafana_protocol() { GRAFANA_PROTOCOL=http; refresh_grafana_url; }
  require_admin_secret() { :; }
  grafana_bin() { echo "/usr/bin/true"; }
  # pid_file_alive is NOT mocked — the real one runs. Before spawn_detached
  # runs it correctly reports "not alive" (no pid file exists yet), and
  # after our spawn_detached mock writes this subshell's own $$ (genuinely
  # alive throughout the test) it correctly reports "alive", matching what
  # a real successful spawn looks like without spawning any real process.
  spawn_detached() {
    env | grep '^GF_SERVER_HTTP_ADDR=' > "$BIND_CAPTURE"
    echo "$$" > "$RUN_DIR/grafana.pid"
  }
  wait_http() { printf '%s' "$1" > "$PROBE_CAPTURE"; }
  GRAFANA_ADMIN_USER=admin
  GRAFANA_ADMIN_PASSWORD=irrelevant-mocked
  start_grafana
)
subshell_status=$?
set -e
[[ "$subshell_status" -eq 0 ]] || fail "mocked start_grafana exited $subshell_status (real body failure, not swallowed)"

BIND_SEEN="$(sed -n 's/^GF_SERVER_HTTP_ADDR=//p' "$BIND_CAPTURE" 2>/dev/null || true)"
PROBE_SEEN="$(cat "$PROBE_CAPTURE" 2>/dev/null || true)"
[[ -n "$BIND_SEEN" ]] || fail "spawn_detached mock never captured GF_SERVER_HTTP_ADDR"
[[ -n "$PROBE_SEEN" ]] || fail "wait_http mock never captured a probe URL"
[[ "$PROBE_SEEN" == *"://$BIND_SEEN:"* ]] || fail "bind address ($BIND_SEEN) not found in readiness probe URL ($PROBE_SEEN) — bind/probe mismatch"
echo "PASS: start_grafana passes the same resolved address ($BIND_SEEN) into GF_SERVER_HTTP_ADDR and the readiness probe URL ($PROBE_SEEN)"

# --- Test 6: negative control — prove test 5's comparison genuinely
#     discriminates a mismatch rather than passing vacuously. ---
if [[ "https://100.99.99.99:3031/api/health" == *"://100.11.11.11:"* ]]; then
  fail "negative-control comparison did not discriminate a real mismatch"
fi
echo "PASS: negative control — an intentionally mismatched address pair is correctly flagged as not matching"

echo "telemetry-stack-bind-probe.test.sh: all checks passed"
