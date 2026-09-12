# Daemon–server protocol proposal archive

This path formerly contained a design proposal for replacing the daemon's
durable WebSocket outbox with several new HTTP transports. That proposal is not
the implemented protocol and should not be used as operator or contributor
guidance.

The current delivery classes, acknowledgement rules, replay behavior, ordering,
and dead-letter handling are documented in
[Daemon–server message delivery](daemon-server-protocol.md).
