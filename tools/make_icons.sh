#!/usr/bin/env bash
# Gera os ícones PNG a partir de icons/favicon.svg usando o Chrome sem interface.
# Uso: tools/make_icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME=${CHROME:-google-chrome}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Ícone "any": como o SVG. "full": sem cantos arredondados e com margem extra,
# para o Android (maskable) e o iOS recortarem do jeito deles.
FULL=$(sed -e 's/rx="14"//' -e 's#<path d="M32 9#<g transform="translate(32 32) scale(.78) translate(-32 -32)"><path d="M32 9#' -e 's#</svg>#</g></svg>#' icons/favicon.svg)

render() { # $1 = conteúdo svg, $2 = tamanho, $3 = saída
  printf '<html><body style="margin:0;background:transparent">%s</body></html>' \
    "$(sed "s#<svg #<svg width=\"$2\" height=\"$2\" #" <<<"$1")" > "$TMP/i.html"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$2,$2" --screenshot="$PWD/$3" "file://$TMP/i.html" 2>/dev/null
}

ANY=$(cat icons/favicon.svg)
render "$ANY" 192 icons/icon-192.png
render "$ANY" 512 icons/icon-512.png
render "$FULL" 512 icons/icon-maskable-512.png
render "$FULL" 180 icons/apple-touch-icon.png
echo "ícones gerados em icons/"
