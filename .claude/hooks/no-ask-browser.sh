#!/bin/bash
# Reject AskUserQuestion if it's asking the user to check browser state.
# The agent has puppeteer and MCP tools — it should use them.
INPUT=$(cat)
QUESTIONS=$(echo "$INPUT" | jq -r '.tool_input.questions[]?.question // empty' 2>/dev/null)

if echo "$QUESTIONS" | grep -qiE 'console|screen|browser|what do you see|screenshot|report.*error|check.*page|look.* at|tell me what|what.*(show|display|appear|render)'; then
  echo '{"decision":"block","reason":"Use puppeteer or MCP tools to check browser state yourself. Don'\''t ask the user to report what they see."}'
else
  echo '{"decision":"approve"}'
fi
