# Fleet Query Language

Fleet tools use one small expression language in two typed positions:

- **Agent-set expressions** resolve to agents. Chat recipients use this type.
- **Event-set expressions** resolve to messages, tasks, activity, and log entries. Search and inbox filters use this type. Event expressions embed agent-set expressions in fields such as `from:` and `to:`.

## Agent-Set Expressions

Agent-set expressions are boolean expressions over agent names, fleet ids, labels, model/cwd selectors where supported by the surface, and reserved affordances.

Operators:

| Syntax | Meaning |
| --- | --- |
| `a | b` | agents matching `a` or `b` |
| `a & b` | agents matching both `a` and `b` |
| `!a` | agents not matching `a` |
| `(a | b) & c` | grouping |

Common leaves:

| Leaf | Meaning |
| --- | --- |
| `skip` | agent with friendly name or searchable name `skip` |
| `fleet:skip` | exact fleet id |
| `ops` | name or label |
| `awake` | status label |
| `cwd:tlda` | cwd selector on surfaces that expose cwd matching |
| `model:gpt-5.5` | model selector on surfaces that expose model matching |
| `me` | the calling agent or human |

Examples:

```text
skip
fleet:skip
skip | guidance
ops & awake
reviewers & !goose
me
```

## Event-Set Expressions

Event-set expressions filter messages and log events. Bare agent-set leaves mean "involving this agent set." Directional fields restrict a side of the event.

| Syntax | Meaning |
| --- | --- |
| `from:ops` | events sent by agents matching `ops` |
| `to:skip` | events sent to agents matching `skip` |
| `involving:(ops | guidance)` | events where either side matches the agent-set expression |
| `type:chat` | event type |
| `since:2h` | events after a relative or ISO time |
| `before:now` | events before a relative or ISO time |
| `a <> b` | conversation between agent sets `a` and `b` |

Agent-set expressions are subexpressions:

```text
from:(ops & awake)
to:(skip | helm)
involving:me & type:chat
(from:ops | from:helm) & !to:goose
```

## Text Search

Search text is natural text, not raw SQLite FTS syntax. Punctuation and words such as `OR`, `NOT`, and `-` are treated as literal search text.

Examples:

```text
teacher-bot
fleet-daemon
query language
agent:(skip | guidance) teacher-bot
from:me fleet-daemon
type:chat since:2h search logs
```

This means `teacher-bot` searches for the hyphenated text. It does not mean `teacher AND NOT bot`.

## Project Agent History

Use `cwd:` or `project:` in search to list agents who worked in a directory or
project by chronological recency instead of searching for the path as text.

Examples:

```text
cwd:/Users/skip/work/tlda
project:tlda
project:/Users/skip/work/tlda
```

Each row identifies the agent, working directory, last relevant event/session
time, recent activity pointer, and a `get_thread(agent:"...")` opener.

## Surface Types

| Surface | Field Type |
| --- | --- |
| `chat` recipient | agent-set expression |
| `fleet_table` filter | agent-set expression |
| `get_thread(agent)` | agent-set expression |
| `get_thread(filter)` | event-set expression |
| `search_logs(query)` | natural text plus event-set filters |
| `search_logs(agent)` | agent-set expression |
| inbox filters | event-set expression |
| UI search | should use the same natural text plus event-set filters |

## Implementation Rule

Do not pass user query text directly to backend search engines. Parse the public fleet query language first, resolve `me` against the caller, translate agent-set subexpressions to agent ids, and quote natural search terms before they reach SQLite FTS.
