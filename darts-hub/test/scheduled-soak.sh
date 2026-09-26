#!/bin/bash
# scheduled-soak.sh - one unattended check-in: every suite, the 09:00 restart
# end to end, and a soak, all against the repo code. Prints one summary block
# and writes $SP/scheduled-<stamp>.json. Exit 0 only when everything passed.
#   SOAK_MIN  soak length in minutes (default 25)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${DARTS_TEST_TMP:-/tmp/winchester-test}"; mkdir -p "$SP"
STAMP=$(date -u +%Y%m%d-%H%M)
OUT="$SP/scheduled-$STAMP.json"
cd "$HERE"
[ -d node_modules/playwright-core ] || npm install --no-audit --no-fund > /dev/null 2>&1
COMMIT=$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)

echo "== check-in $STAMP on commit $COMMIT =="
./runall.sh > "$SP/sched-runall.log" 2>&1; RA=$?
RA_LINE=$(tail -1 "$SP/sched-runall.log")
echo "suites:   $RA_LINE"
grep "^    FAIL" "$SP/sched-runall.log"

rm -f "$SP/restarttest.done"
TPORT=8890 node restarttest.js > "$SP/sched-restart.log" 2>&1; RT=$?
RT_LINE=$(cat "$SP/restarttest.done" 2>/dev/null)
echo "restart:  ${RT_LINE:-no result}"
grep "FAIL" "$SP/restarttest.log" | sed 's/^/    /'

rm -f "$SP/soak.done"
SOAK_MIN="${SOAK_MIN:-25}" node soak.js > "$SP/sched-soak.log" 2>&1; SK=$?
SOAK_V=$(cat "$SP/soak.done" 2>/dev/null || echo "no result")
SOAK_SUM=$(node -e "const r=require('$SP/soak-results.json');const s=r.samples;const rss=s.map(x=>x.hubRssMb).filter(Boolean);console.log(\`darts \${s[s.length-1].packets}, games \${r.gamesFinished}/\${r.gamesStarted}, power cycles \${r.powerCycles}, bills \${r.billingToasts}, page errors \${Object.values(r.pageErrors).flat().length+Object.values(r.consoleErrors).flat().length}, stuck cards \${r.stuckCelebrations}, RSS \${rss[0]}->\${rss[rss.length-1]} MB (peak \${Math.max(...rss)})\`)" 2>/dev/null || echo "-")
echo "soak:     $SOAK_V — $SOAK_SUM"

OK=0; [ "$RA" -eq 0 ] && [ "$RT" -eq 0 ] && [ "$SK" -eq 0 ] && OK=1
node -e "require('fs').writeFileSync('$OUT', JSON.stringify({ stamp: '$STAMP', commit: '$COMMIT', ok: $OK, suites: '$RA_LINE', restart: '${RT_LINE:-}', soak: '$SOAK_V', soakSummary: process.argv[1] }, null, 2))" "$SOAK_SUM"
echo "result:   $([ $OK -eq 1 ] && echo ALL GREEN || echo FAILURES) — details in $OUT"
exit $((1 - OK))
