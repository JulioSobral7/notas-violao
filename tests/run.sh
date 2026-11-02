#!/usr/bin/env bash
# Roda os testes no Chrome sem interface e imprime o resultado.
#   tests/run.sh          testes unitários + comparação de detectores
#   tests/run.sh unit     só os unitários
#   tests/run.sh bench    só a comparação
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8765}
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
sleep 0.5

status=0
run_page() {
  local out
  out=$("${CHROME:-google-chrome}" --headless --disable-gpu --dump-dom "http://127.0.0.1:$PORT/tests/$1" 2>/dev/null)
  python3 -c 'import html,re,sys; m=re.search(r"<pre id=\"out\">(.*?)</pre>", sys.stdin.read(), re.S); print(html.unescape(m.group(1)) if m else "sem saída")' <<<"$out"
  grep -q '<title>OK</title>' <<<"$out" || status=1
}

case "${1:-all}" in
  unit) run_page test.html ;;
  bench) run_page bench.html ;;
  *) run_page test.html; echo; run_page bench.html ;;
esac
exit $status
