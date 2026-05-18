#!/bin/bash
# Run verify-screenshot on all overnight report images
DIR="data/overnight-report"
OUT="$DIR/results"
mkdir -p "$OUT"

run() {
  local file="$1"
  local criteria="$2"
  local name=$(basename "$file" .png)
  echo "Verifying: $name"
  timeout 60 node bin/verify-screenshot "$file" "$criteria" > "$OUT/$name.json" 2>/dev/null || echo '{"pass":false,"description":"verify-screenshot timed out or failed","issues":["tool error"]}' > "$OUT/$name.json"
  cat "$OUT/$name.json" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const j=JSON.parse(d);console.log(j.pass?'  PASS':'  FAIL',j.description?.substring(0,100))}catch{console.log('  ERROR',d.substring(0,100))}"
}

run "$DIR/01-image-render.png" "Chat message with an inline rendered image visible, not a text path"
run "$DIR/02a-pill-normal.png" "Send hint pill showing enter symbol and agent name in normal mode"
run "$DIR/02b-pill-interrupt.png" "Send hint pill with orange interrupt mode indicator"
run "$DIR/02c-pill-queue.png" "Send hint pill with cyan queue mode indicator"
run "$DIR/03-scroll-bottom.png" "Chat fully scrolled to bottom, last message fully visible, no gap"
run "$DIR/04-theme-early.png" "Dark theme with no white flash or wrong colors, purple/dark background"
run "$DIR/05-agent-list.png" "Agent list panel with agent names, status, and task info"
run "$DIR/06-terminal.png" "Terminal widget showing xterm.js output with ANSI colors"
run "$DIR/07-tasks-table.png" "Tasks table with status badges, agent names, descriptions"
run "$DIR/08-mathjax-tour.png" "Math equations rendered with MathJax, not raw LaTeX"
run "$DIR/09-slides-spatial.png" "Slide navigator showing slide number, slide content visible"
run "$DIR/11-highlighter-strip.png" "Vertical strip with colored dots for highlighter tool"
run "$DIR/11-highlighter-drag.png" "Contextual color slider appearing on drag"
run "$DIR/12-dot-collapsed.png" "Small colored dot visible as annotation marker"

echo ""
echo "=== DONE ==="
