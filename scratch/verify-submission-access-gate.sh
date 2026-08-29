#!/usr/bin/env bash
# Does the class read token still reach a student's handed-in work?
#
# The exact URLs the exposure was measured on, run three ways, because a gate
# that also refuses the two people entitled to the document is not a gate, it is
# an outage:
#
#   no token      must be 401   — the box is not open to the world
#   read token    must be 403   — the QR-code token every classmate holds
#   rw token      must be 200   — the instructor, who marks this
#
# Plus one positive control that must stay 200 on the read token: the book. If
# the book went dark too, the gate is wrong in the other direction and the class
# cannot read anything.
#
# Usage:  TLDA_PIC_RW=<rw token> bash scratch/verify-submission-access-gate.sh
set -uo pipefail

HOST=${HOST:-https://tlda-pic.cormorant-matrix.ts.net}
READ=${TLDA_PIC_READ:-fa32c1eba25856d3368003cb0689ab66}
RW=${TLDA_PIC_RW:-}

SUB=${SUB:-'submission-hw-minus-1-setup-qtm285:photo-demo-0828-1519'}
ENC=$(node -pe 'encodeURIComponent(process.argv[1])' "$SUB")

fails=0
check() { # label url expected [token]
  local label=$1 url=$2 want=$3 token=${4:-}
  local got
  if [ -n "$token" ]; then
    got=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$url")
  else
    got=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  fi
  if [ "$got" = "$want" ]; then
    printf '  ok    %-52s %s\n' "$label" "$got"
  else
    printf '  FAIL  %-52s %s (wanted %s)\n' "$label" "$got" "$want"
    fails=$((fails + 1))
  fi
}

echo "host      $HOST"
echo "serving   $(curl -s -H "Authorization: Bearer $READ" "$HOST/api/build-info" | node -pe 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).gitSha.slice(0,9)}catch(e){"?"}')"
echo

echo "no token — nothing is open to the world"
for f in page-info.json hw-minus-1.html my-photo.png; do
  check "/docs/<submission>/$f" "$HOST/docs/$ENC/$f" 401
done
check "/api/projects" "$HOST/api/projects" 401

echo
echo "class read token — the QR code, refused a classmate's work"
for f in page-info.json hw-minus-1.html my-photo.png; do
  check "/docs/<submission>/$f" "$HOST/docs/$ENC/$f" 403 "$READ"
done
check "/api/projects/<submission>" "$HOST/api/projects/$ENC" 403 "$READ"

echo
echo "class read token — the index no longer names who handed in what"
listed=$(curl -s -H "Authorization: Bearer $READ" "$HOST/api/projects" \
  | node -pe 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));(d.projects||d).filter(p=>String(p.name).startsWith("submission-")).length')
if [ "$listed" = "0" ]; then
  printf '  ok    %-52s %s\n' "submission projects listed" "$listed"
else
  printf '  FAIL  %-52s %s (wanted 0)\n' "submission projects listed" "$listed"
  fails=$((fails + 1))
fi

echo
echo "class read token — the same work through its history"
for u in history/shadow history/shadow/bounds; do
  check "/api/projects/<submission>/$u" "$HOST/api/projects/$ENC/$u" 403 "$READ"
done
answered() { # token names-json
  curl -s -X POST -H "Authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"projects\":[\"$SUB\"]}" "$HOST/api/projects/history/shadow/changelog/batch" \
  | node -pe 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")).projects;Array.isArray(p)?p.length:Object.keys(p||{}).length'
}
n=$(answered "$READ")
if [ "$n" = "0" ]; then
  printf '  ok    %-52s %s\n' "batch changelog: projects answered for" "$n"
else
  printf '  FAIL  %-52s %s (wanted 0)\n' "batch changelog: projects answered for" "$n"
  fails=$((fails + 1))
fi

echo
echo "class read token — the manifest no longer names them"
mannames=$(curl -s -H "Authorization: Bearer $READ" "$HOST/docs/manifest.json" \
  | node -pe 'Object.keys(JSON.parse(require("fs").readFileSync(0,"utf8")).documents||{}).filter(n=>n.startsWith("submission-")).length')
if [ "$mannames" = "0" ]; then
  printf '  ok    %-52s %s\n' "/docs/manifest.json: submissions named" "$mannames"
else
  printf '  FAIL  %-52s %s (wanted 0)\n' "/docs/manifest.json: submissions named" "$mannames"
  fails=$((fails + 1))
fi

echo
echo "class read token — the sync room, over a real WebSocket"
wsprobe() { # token room [raw|encoded]  -> OPEN | refused N
  ( cd "$(dirname "$0")/../server" && TOKEN="$1" ROOM="$2" SPELLING="${3:-encoded}" HOSTWS="${HOST/https:/wss:}" node -e '
import("ws").then(({default: WebSocket}) => {
  const room = process.env.SPELLING === "raw" ? process.env.ROOM : encodeURIComponent(process.env.ROOM)
  const url = `${process.env.HOSTWS}/sync/${room}?sessionId=probe-gate&token=${process.env.TOKEN}`
  const ws = new WebSocket(url)
  const say = v => { console.log(v); try { ws.close() } catch {} ; process.exit(0) }
  setTimeout(() => say("timeout"), 8000)
  ws.on("open", () => say("OPEN"))
  ws.on("unexpected-response", (_r, res) => say("refused " + res.statusCode))
  ws.on("error", e => say("error " + e.message))
})' 2>/dev/null )
}
# Both spellings of the room. `url.pathname` is not url-decoded and a student id
# is `<course>:<login>`, so a client that percent-encodes the colon reaches a
# lookup that matches no content_ref. Measured once with the gate deployed:
# literal colon refused 403, encoded one accepted, same room. Probing only one
# spelling is a check that cannot see the bug it exists for.
sub_room="doc-$SUB"
for spelling in raw encoded; do
  got=$(wsprobe "$READ" "$sub_room" "$spelling")
  if [ "$got" = "refused 403" ]; then
    printf '  ok    %-52s %s\n' "/sync/doc-<submission>  ($spelling)" "$got"
  else
    printf '  FAIL  %-52s %s (wanted refused 403)\n' "/sync/doc-<submission>  ($spelling)" "$got"
    fails=$((fails + 1))
  fi
done
got=$(wsprobe "$READ" "doc-qtm285-book")
if [ "$got" = "OPEN" ]; then
  printf '  ok    %-52s %s\n' "/sync/doc-qtm285-book  (POSITIVE CONTROL)" "$got"
else
  printf '  FAIL  %-52s %s (wanted OPEN)\n' "/sync/doc-qtm285-book  (POSITIVE CONTROL)" "$got"
  fails=$((fails + 1))
fi

echo
echo "class read token — POSITIVE CONTROL: the book is still readable"
check "/docs/qtm285-book/page-info.json" "$HOST/docs/qtm285-book/page-info.json" 200 "$READ"
check "/api/projects (the index itself)" "$HOST/api/projects" 200 "$READ"

if [ -n "$RW" ]; then
  echo
  echo "rw token — the instructor still marks it"
  for f in page-info.json hw-minus-1.html my-photo.png; do
    check "/docs/<submission>/$f" "$HOST/docs/$ENC/$f" 200 "$RW"
  done
  check "/api/projects/<submission>" "$HOST/api/projects/$ENC" 200 "$RW"
  for u in history/shadow history/shadow/bounds; do
    check "/api/projects/<submission>/$u" "$HOST/api/projects/$ENC/$u" 200 "$RW"
  done
  rwn=$(answered "$RW")
  if [ "$rwn" -ge 1 ]; then
    printf '  ok    %-52s %s\n' "batch changelog: projects answered for" "$rwn"
  else
    printf '  FAIL  %-52s %s (wanted >= 1)\n' "batch changelog: projects answered for" "$rwn"
    fails=$((fails + 1))
  fi
  rwlisted=$(curl -s -H "Authorization: Bearer $RW" "$HOST/api/projects" \
    | node -pe 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));(d.projects||d).filter(p=>String(p.name).startsWith("submission-")).length')
  if [ "$rwlisted" -ge 1 ]; then
    printf '  ok    %-52s %s\n' "submission projects listed" "$rwlisted"
  else
    printf '  FAIL  %-52s %s (wanted >= 1)\n' "submission projects listed" "$rwlisted"
    fails=$((fails + 1))
  fi
else
  echo
  echo "  SKIPPED instructor half: set TLDA_PIC_RW. Half a proof is not a proof —"
  echo "  a gate nobody can get through would pass every check above."
  fails=$((fails + 1))
fi

echo
[ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$fails CHECK(S) FAILED"
exit $((fails > 0))
