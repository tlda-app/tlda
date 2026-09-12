#!/bin/zsh
# End-to-end proof of the public classroom flow on the live class box.
#
# Every step prints the HTTP status it actually received. A step that cannot
# distinguish success from a 401 is not a step -- AGENTS.md ยง"An instrument that
# answers is not an instrument that measured", and a 401 body here parses as
# perfectly good JSON.
#
# This drives HTTP only. It deliberately does NOT drive a browser: an automated
# session applies the 3-col fleet preset and writes six shapes into the target
# project's synced room, which for qtm285-book is the room students open.
# See AGENTS.md ยง"Driving a browser at a project writes into that project".
#
# Usage:  TLDA_READ=... TLDA_RW=... ./verify-public-classroom-flow.sh
#
# The client half of criterion 1 -- whether the Continue button renders and
# where it points -- is NOT provable here, because it is drawn by JS. Check it
# by reading the bundle named in index.html: the fixed code has a distinct
# get("project") and gates the link on it; the old code has only get("course")
# and calls set("project", <course id>).

set -u

BOX=${BOX:-https://tlda-pic.cormorant-matrix.ts.net}
COURSE=${COURSE:-qtm285}
BOOK=${BOOK:-qtm285-book}
ASSIGNMENT=${ASSIGNMENT:-hw-minus-1-setup}
READ_TOKEN=${TLDA_READ:?set TLDA_READ}
RW_TOKEN=${TLDA_RW:?set TLDA_RW}

STUDENT_LOGIN=${STUDENT_LOGIN:-flowcheck-$(date -u +%H%M%S)}
JAR=$(mktemp -t clsjar)
WORK=$(mktemp -d -t clsflow)
fails=0

step() { print -r -- "\n=== $* ==="; }
check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then print -r -- "  PASS  $1 (HTTP $2)"
  else print -r -- "  FAIL  $1 (HTTP $2, wanted $3)"; fails=$((fails+1)); fi
}

step "0. Which code is the box running"
build=$(curl -s --max-time 20 "$BOX/api/build-info")
print -r -- "  $build"

step "1. Read-token login sets a cookie, and project survives the redirect"
code=$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' --max-time 25 \
  "$BOX/auth/login?token=$READ_TOKEN&redirect=%2F%3Fworkspace%3Dclassroom-register%26course%3D$COURSE%26project%3D$BOOK")
check "GET /auth/login" "$code" "302"
grep -q tlda_token "$JAR" && print -r -- "  PASS  cookie set" || { print -r -- "  FAIL  no cookie"; fails=$((fails+1)); }

step "2. A fresh student registers -- cookie only, no Authorization header"
code=$(curl -s -b "$JAR" -o "$WORK/reg.json" -w '%{http_code}' --max-time 25 \
  -H 'Content-Type: application/json' \
  -d "{\"displayName\":\"Flow Check\",\"universityLogin\":\"$STUDENT_LOGIN\"}" \
  "$BOX/api/classroom/courses/$COURSE/register")
check "POST register" "$code" "201"
STUDENT_TOKEN=$(python3 -c "import json;print(json.load(open('$WORK/reg.json')).get('enrollmentToken',''))" 2>/dev/null)
[[ -n "$STUDENT_TOKEN" ]] && print -r -- "  PASS  enrollment token issued" \
  || { print -r -- "  FAIL  no enrollment token"; fails=$((fails+1)); }

step "3. The student's own token resolves them"
code=$(curl -s -o "$WORK/me.json" -w '%{http_code}' --max-time 25 \
  -H "x-tlda-student-token: $STUDENT_TOKEN" "$BOX/api/classroom/me")
check "GET /api/classroom/me" "$code" "200"

step "4. The book serves three pages, and each one has text on it"
code=$(curl -s -b "$JAR" -o "$WORK/pageinfo.json" -w '%{http_code}' --max-time 25 \
  "$BOX/docs/$BOOK/page-info.json")
check "GET page-info.json" "$code" "200"
python3 - "$WORK/pageinfo.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if not isinstance(d,list):
    print(f"  FAIL  page-info is {type(d).__name__}, not a list -- this is the 401-reads-as-blank shape"); sys.exit(1)
print(f"  PASS  {len(d)} pages: " + ", ".join(e.get('title','?') for e in d))
PY
[[ $? -ne 0 ]] && fails=$((fails+1))
for f in $(python3 -c "
import json
print(' '.join(e.get('file','') for e in json.load(open('$WORK/pageinfo.json'))))" 2>/dev/null); do
  n=$(curl -s -b "$JAR" --max-time 25 "$BOX/docs/$BOOK/$f" | python3 -c "
import sys,re
h=sys.stdin.read()
h=re.sub(r'(?is)<(script|style).*?</\1>',' ',h)
print(len(re.sub(r'\s+',' ',re.sub(r'(?s)<[^>]+>',' ',h)).strip()))")
  if [[ "$n" -gt 200 ]]; then print -r -- "  PASS  $f -- $n visible chars"
  else print -r -- "  FAIL  $f -- only $n visible chars"; fails=$((fails+1)); fi
done

step "5. The assignment has a frozen template (the download depends on it)"
curl -s --max-time 25 -H "Authorization: Bearer $RW_TOKEN" \
  "$BOX/api/classroom/courses/$COURSE/assignments" > "$WORK/asg.json"
python3 - "$WORK/asg.json" "$ASSIGNMENT" <<'PY'
import json,sys
a=next((x for x in json.load(open(sys.argv[1]))['assignments'] if x['id']==sys.argv[2]), None)
if not a: print("  FAIL  assignment missing"); sys.exit(1)
ok = a.get('templateDocKey') and a.get('templateVersion')
print(("  PASS  frozen: " if ok else "  FAIL  NOT frozen -- download 404s and the archive check is inactive: ")
      + f"templateDocKey={a.get('templateDocKey')} templateVersion={a.get('templateVersion')}")
sys.exit(0 if ok else 1)
PY
[[ $? -ne 0 ]] && fails=$((fails+1))

step "6. Instructor list distinguishes submitted from not"
IJAR=$(mktemp -t clsijar)
curl -s -c "$IJAR" -o /dev/null --max-time 25 \
  "$BOX/auth/login?token=$RW_TOKEN&redirect=%2F%3Fworkspace%3Dclassroom-gradebook%26course%3D$COURSE" >/dev/null
code=$(curl -s -b "$IJAR" -o "$WORK/status.json" -w '%{http_code}' --max-time 25 \
  "$BOX/api/classroom/courses/$COURSE/status")
check "GET /status (cookie only)" "$code" "200"
python3 - "$WORK/status.json" "$STUDENT_LOGIN" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
rows=d.get('rows',[])
print("  counts:", d.get('counts'))
for r in rows:
    print(f"    {r['displayName']:22} {r['assignments'][0]['state']}")
if any(r['id'].endswith(':'+sys.argv[2]) for r in rows):
    print(f"  PASS  the student registered by this run appears in the instructor list")
else:
    print(f"  FAIL  student {sys.argv[2]} registered but is absent from the instructor list"); sys.exit(1)
PY
[[ $? -ne 0 ]] && fails=$((fails+1))

print -r -- "\n=================================================="
if [[ $fails -eq 0 ]]; then print -r -- "ALL CHECKS PASSED  (student: $COURSE:$STUDENT_LOGIN)"
else print -r -- "$fails CHECK(S) FAILED  (student: $COURSE:$STUDENT_LOGIN)"; fi
print -r -- "Not covered here: the Continue button (client-side; read the bundle)"
print -r -- "and the Positron extension's own Submit command (drive the plugin)."
exit $fails
