# Live agent activity dashboard

This directory provisions a read-only Grafana OSS dashboard over the real Fly
fleet APIs. Grafana is only a view: it creates no activity emitter, agent state,
or lifecycle fact.

The first visible panel shows current voice-pipeline health from structured
browser live-performance samples. The remaining panels show the current
bounded roster projection and the latest 250 persisted activity events through
the ordered `before` cursor.

Configure the server that serves the project index with its public dashboard URL:

```yaml
# ~/.config/tlda/server.yaml
telemetryUrl: https://davids-mac-mini.cormorant-matrix.ts.net:3031/d/tlda-live-agent-activity/live-agent-activity
```

Omit `telemetryUrl` on installations without this dashboard; the index then shows
no telemetry link.

Install the dashboard's dedicated launchd job (it is a new job; it does not
modify any existing tlda job):

```sh
cp telemetry/com.tlda.grafana.plist ~/Library/LaunchAgents/com.tlda.grafana.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tlda.grafana.plist
```

The job generates a local Grafana admin password on first start and exposes the
dashboard only to tailnet users as an anonymous Viewer. The index link is the
supported entry point.

For a one-off local start instead:

```sh
telemetry/stack.sh start
```

The script prints the live Tailscale URL. It provisions Grafana and the Infinity
JSON datasource under `telemetry/.stack/`; it does not start or alter tlda.

Stop or inspect it with:

```sh
telemetry/stack.sh status
telemetry/stack.sh stop
```
