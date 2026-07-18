# Live agent activity dashboard

This directory provisions a read-only Grafana OSS dashboard over the real Fly
fleet APIs. Grafana is only a view: it creates no activity emitter, agent state,
or lifecycle fact.

The first visible panels show voice-pipeline health from two existing sources:
browser live-performance samples and the bounded tail of the Deepgram bridge
log. They distinguish browser capture, the tlda bridge, and Deepgram upstream.
The remaining panels show the current bounded roster projection and the latest
250 persisted activity events through the ordered `before` cursor.

Start the dashboard:

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
