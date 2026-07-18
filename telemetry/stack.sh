#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TELEMETRY_DIR="$ROOT/telemetry"
STACK_DIR="$TELEMETRY_DIR/.stack"
BIN_DIR="$STACK_DIR/bin"
RUN_DIR="$STACK_DIR/run"
LOG_DIR="$STACK_DIR/logs"
RENDER_DIR="$STACK_DIR/rendered"
PROM_DATA_DIR="$STACK_DIR/prometheus-data"
GRAFANA_DATA_DIR="$STACK_DIR/grafana-data"
GRAFANA_LOG_DIR="$STACK_DIR/grafana-logs"
GRAFANA_PLUGIN_DIR="$STACK_DIR/grafana-plugins"

GRAFANA_VERSION="${GRAFANA_VERSION:-11.5.2}"
PROMETHEUS_VERSION="${PROMETHEUS_VERSION:-2.55.1}"
GRAFANA_PORT="${GRAFANA_PORT:-3031}"
PROMETHEUS_PORT="${PROMETHEUS_PORT:-9099}"
GRAFANA_ADMIN_USER="${GRAFANA_ADMIN_USER:-admin}"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-admin}"
INFINITY_PLUGIN_ID="${INFINITY_PLUGIN_ID:-yesoreyeram-infinity-datasource}"

PROM_URL="http://127.0.0.1:${PROMETHEUS_PORT}"
PROM_OTLP_ENDPOINT="${PROM_URL}/api/v1/otlp/v1/metrics"
GRAFANA_HOST="${GRAFANA_HOST:-0.0.0.0}"
GRAFANA_PUBLIC_HOST="${GRAFANA_PUBLIC_HOST:-davids-mac-mini.cormorant-matrix.ts.net}"
GRAFANA_CERT_FILE="${GRAFANA_CERT_FILE:-$STACK_DIR/certs/${GRAFANA_PUBLIC_HOST}.crt}"
GRAFANA_CERT_KEY="${GRAFANA_CERT_KEY:-$STACK_DIR/certs/${GRAFANA_PUBLIC_HOST}.key}"
GRAFANA_PROTOCOL="${GRAFANA_PROTOCOL:-http}"
if [[ "$GRAFANA_PROTOCOL" == "http" && -f "$GRAFANA_CERT_FILE" && -f "$GRAFANA_CERT_KEY" ]]; then
  GRAFANA_PROTOCOL=https
fi
TLDA_FLEET_URL="${TLDA_FLEET_URL:-https://tlda-fly.cormorant-matrix.ts.net}"
GRAFANA_URL="${GRAFANA_PROTOCOL}://${GRAFANA_PUBLIC_HOST}:${GRAFANA_PORT}/d/tlda-live-agent-activity/live-agent-activity"

mkdir -p "$BIN_DIR" "$RUN_DIR" "$LOG_DIR" "$RENDER_DIR" "$PROM_DATA_DIR" "$GRAFANA_DATA_DIR" "$GRAFANA_LOG_DIR" "$GRAFANA_PLUGIN_DIR"

die() {
  echo "telemetry stack: $*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

main_checkout_root() {
  local common
  common="$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ -n "$common" ]] || return 1
  if [[ "$common" != /* ]]; then
    common="$ROOT/$common"
  fi
  dirname "$common"
}

ensure_node_modules() {
  if [[ -e "$ROOT/node_modules" ]]; then
    return 0
  fi
  local main_root
  main_root="$(main_checkout_root || true)"
  if [[ -n "$main_root" && -d "$main_root/node_modules" ]]; then
    ln -s "$main_root/node_modules" "$ROOT/node_modules"
    return 0
  fi
  die "missing node_modules for Vite build; run npm ci in this worktree or keep the main checkout install available"
}

pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

pid_file_alive() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  pid_alive "$pid"
}

wait_http() {
  local url="$1"
  local label="$2"
  local max="${3:-60}"
  for _ in $(seq 1 "$max"); do
    if curl -kfsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "$label did not answer at $url"
}

spawn_detached() {
  local pid_file="$1"
  local log_file="$2"
  shift 2
  node - "$pid_file" "$log_file" "$@" <<'NODE'
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const [pidFile, logFile, cmd, ...args] = process.argv.slice(2)
const fd = fs.openSync(logFile, 'a')
const child = spawn(cmd, args, {
  detached: true,
  stdio: ['ignore', fd, fd],
  env: process.env,
})
child.unref()
fs.writeFileSync(pidFile, String(child.pid))
NODE
}

download_and_unpack() {
  local name="$1"
  local version="$2"
  local url="$3"
  local target="$4"
  local marker="$target/.version"
  if [[ -x "$target/bin/$name" && -f "$marker" && "$(cat "$marker")" == "$version" ]]; then
    return 0
  fi

  rm -rf "$target" "$target.tmp"
  mkdir -p "$target.tmp"
  local archive="$STACK_DIR/${name}-${version}.tar.gz"
  echo "downloading $name $version"
  curl -fL "$url" -o "$archive"
  tar -xzf "$archive" -C "$target.tmp" --strip-components=1
  mv "$target.tmp" "$target"
  echo "$version" > "$marker"
}

prometheus_bin() {
  if [[ -x "$BIN_DIR/prometheus/bin/prometheus" ]]; then
    echo "$BIN_DIR/prometheus/bin/prometheus"
  else
    echo "$BIN_DIR/prometheus/prometheus"
  fi
}

grafana_bin() {
  echo "$BIN_DIR/grafana/bin/grafana"
}

grafana_cli_bin() {
  if [[ -x "$BIN_DIR/grafana/bin/grafana-cli" ]]; then
    echo "$BIN_DIR/grafana/bin/grafana-cli"
  else
    echo "$BIN_DIR/grafana/bin/grafana"
  fi
}

download() {
  [[ "$(uname -s)" == "Darwin" ]] || die "this slice downloads darwin-arm64 binaries only"
  [[ "$(uname -m)" == "arm64" ]] || die "this slice downloads darwin-arm64 binaries only"
  have curl || die "curl is required"
  have tar || die "tar is required"

  download_and_unpack \
    grafana \
    "$GRAFANA_VERSION" \
    "https://dl.grafana.com/oss/release/grafana-${GRAFANA_VERSION}.darwin-arm64.tar.gz" \
    "$BIN_DIR/grafana"

  if [[ ! -d "$GRAFANA_PLUGIN_DIR/$INFINITY_PLUGIN_ID" ]]; then
    echo "installing Grafana plugin $INFINITY_PLUGIN_ID"
    local cli
    cli="$(grafana_cli_bin)"
    if [[ "$(basename "$cli")" == "grafana-cli" ]]; then
      "$cli" --pluginsDir "$GRAFANA_PLUGIN_DIR" plugins install "$INFINITY_PLUGIN_ID"
    else
      "$cli" cli --pluginsDir "$GRAFANA_PLUGIN_DIR" plugins install "$INFINITY_PLUGIN_ID"
    fi
  fi
}

render_configs() {
  rm -rf "$RENDER_DIR"
  mkdir -p "$RENDER_DIR/grafana/provisioning/datasources" "$RENDER_DIR/grafana/provisioning/dashboards" "$RENDER_DIR/grafana/dashboards"

  sed \
    -e "s#__TLDA_FLEET_URL__#${TLDA_FLEET_URL}#g" \
    "$TELEMETRY_DIR/grafana/provisioning/datasources/datasources.yml" \
    > "$RENDER_DIR/grafana/provisioning/datasources/datasources.yml"

  sed \
    -e "s#__DASHBOARD_DIR__#${RENDER_DIR}/grafana/dashboards#g" \
    "$TELEMETRY_DIR/grafana/provisioning/dashboards/dashboards.yml" \
    > "$RENDER_DIR/grafana/provisioning/dashboards/dashboards.yml"

  sed \
    -e "s#__TLDA_FLEET_URL__#${TLDA_FLEET_URL}#g" \
    "$TELEMETRY_DIR/grafana/dashboards/tlda-live-agent-activity.json" \
    > "$RENDER_DIR/grafana/dashboards/tlda-live-agent-activity.json"
}

start_prometheus() {
  if pid_file_alive "$RUN_DIR/prometheus.pid"; then
    echo "prometheus already running pid $(cat "$RUN_DIR/prometheus.pid")"
    return 0
  fi
  local bin
  bin="$(prometheus_bin)"
  [[ -x "$bin" ]] || die "prometheus binary missing; run $0 download"
  : > "$LOG_DIR/prometheus.log"
  spawn_detached "$RUN_DIR/prometheus.pid" "$LOG_DIR/prometheus.log" "$bin" \
    --config.file="$RENDER_DIR/prometheus.yml" \
    --storage.tsdb.path="$PROM_DATA_DIR" \
    --web.listen-address="127.0.0.1:${PROMETHEUS_PORT}" \
    --web.enable-remote-write-receiver \
    --enable-feature=otlp-write-receiver
  wait_http "${PROM_URL}/-/ready" "prometheus"
  pid_file_alive "$RUN_DIR/prometheus.pid" || die "prometheus exited after readiness; see $LOG_DIR/prometheus.log"
}

start_grafana() {
  if pid_file_alive "$RUN_DIR/grafana.pid"; then
    echo "grafana already running pid $(cat "$RUN_DIR/grafana.pid")"
    return 0
  fi
  local bin
  bin="$(grafana_bin)"
  [[ -x "$bin" ]] || die "grafana binary missing; run $0 download"
  : > "$LOG_DIR/grafana.log"
  GF_PATHS_DATA="$GRAFANA_DATA_DIR" \
    GF_PATHS_LOGS="$GRAFANA_LOG_DIR" \
    GF_PATHS_PLUGINS="$GRAFANA_PLUGIN_DIR" \
    GF_PATHS_PROVISIONING="$RENDER_DIR/grafana/provisioning" \
    GF_SERVER_HTTP_ADDR="$GRAFANA_HOST" \
    GF_SERVER_HTTP_PORT="$GRAFANA_PORT" \
    GF_SERVER_PROTOCOL="$GRAFANA_PROTOCOL" \
    GF_SERVER_CERT_FILE="$GRAFANA_CERT_FILE" \
    GF_SERVER_CERT_KEY="$GRAFANA_CERT_KEY" \
    GF_SECURITY_ADMIN_USER="$GRAFANA_ADMIN_USER" \
    GF_SECURITY_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD" \
    GF_AUTH_ANONYMOUS_ENABLED=true \
    GF_AUTH_ANONYMOUS_ORG_ROLE=Admin \
    GF_USERS_DEFAULT_THEME=light \
    spawn_detached "$RUN_DIR/grafana.pid" "$LOG_DIR/grafana.log" "$bin" server \
      --homepath "$BIN_DIR/grafana"
  wait_http "${GRAFANA_PROTOCOL}://127.0.0.1:${GRAFANA_PORT}/api/health" "grafana"
  pid_file_alive "$RUN_DIR/grafana.pid" || die "grafana exited after readiness; see $LOG_DIR/grafana.log"
}

start_sandbox() {
  TLDA_OTEL=1 \
  TLDA_OTEL_SERVICE_NAME=tlda-sandbox \
  OTEL_SERVICE_NAME=tlda-sandbox \
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="$PROM_OTLP_ENDPOINT" \
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/protobuf \
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${PROM_URL}/api/v1/otlp/v1/traces" \
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf \
    tlda-dev serve start --sandbox
}

sandbox_url() {
  local status
  status="$(tlda-dev serve status --json 2>/dev/null || true)"
  node -e "const s=JSON.parse(process.argv[1]||'{}'); const row=Array.isArray(s)?s.find(x=>x.branch==='telemetry-dash'&&x.alive):s; console.log(row?.base || row?.url?.replace(/[/?#].*/, '') || '')" "$status"
}

start() {
  download
  render_configs
  start_grafana
  echo
  echo "Grafana:    $GRAFANA_URL"
  echo "Fleet data: $TLDA_FLEET_URL"
  echo
  echo "Stop with:  $0 stop"
}

stop_pid_file() {
  local file="$1"
  local name="$2"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  if pid_alive "$pid"; then
    echo "stopping $name pid $pid"
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      pid_alive "$pid" || break
      sleep 0.5
    done
    if pid_alive "$pid"; then
      kill -TERM "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$file"
}

stop() {
  stop_pid_file "$RUN_DIR/grafana.pid" grafana
}

status() {
  echo "telemetry stack state: $STACK_DIR"
  for name in grafana; do
    local file="$RUN_DIR/$name.pid"
    if pid_file_alive "$file"; then
      echo "$name: running pid $(cat "$file")"
    else
      echo "$name: stopped"
    fi
  done
  echo "fleet data: $TLDA_FLEET_URL"
  echo "grafana url: $GRAFANA_URL"
}

footprint() {
  echo "disk:"
  du -sh "$STACK_DIR" 2>/dev/null || true
  echo
  echo "rss:"
  for name in grafana; do
    local file="$RUN_DIR/$name.pid"
    if pid_file_alive "$file"; then
      ps -o pid=,rss=,pcpu=,comm= -p "$(cat "$file")"
    fi
  done
  local status
  status="$(tlda-dev serve status --json 2>/dev/null || true)"
  node -e "const s=JSON.parse(process.argv[1]||'{}'); const row=Array.isArray(s)?s.find(x=>x.branch==='telemetry-dash'&&x.alive):s; if (row?.pid) console.log(row.pid)" "$status" | while read -r pid; do
    ps -o pid=,rss=,pcpu=,comm= -p "$pid"
  done
}

case "${1:-status}" in
  download) download ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  footprint) footprint ;;
  *)
    cat >&2 <<EOF
Usage: $0 <download|start|stop|restart|status|footprint>

Environment overrides:
  GRAFANA_VERSION=$GRAFANA_VERSION
  PROMETHEUS_VERSION=$PROMETHEUS_VERSION
  GRAFANA_PORT=$GRAFANA_PORT
  PROMETHEUS_PORT=$PROMETHEUS_PORT
EOF
    exit 2
    ;;
esac
