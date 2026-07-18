#!/usr/bin/env bash
# Sincroniza o plugin do repositório para a pasta de plugins do Ulanzi Studio.
# node_modules é preservado (não é copiado nem apagado).
#
# A pasta de plugins do Studio pode ser informada em $ULANZI_PLUGINS_DIR;
# caso contrário, usa o caminho padrão no Windows (%APPDATA%/Ulanzi/UlanziDeck/Plugins).
set -e

PLUGIN="com.ulanzi.spotifynowplaying.ulanziPlugin"
SRC="$(cd "$(dirname "$0")" && pwd)/$PLUGIN"

PLUGINS_DIR="${ULANZI_PLUGINS_DIR:-$APPDATA/Ulanzi/UlanziDeck/Plugins}"
DST="$PLUGINS_DIR/$PLUGIN"

if [ ! -d "$(dirname "$DST")" ]; then
  echo "Pasta de plugins do Studio não encontrada: $PLUGINS_DIR" >&2
  echo "Defina ULANZI_PLUGINS_DIR apontando para a pasta correta." >&2
  exit 1
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude '*.log' "$SRC/" "$DST/"
else
  # Fallback sem rsync: copia os diretórios/arquivos de código.
  for item in manifest.json package.json plugin property-inspector libs assets; do
    rm -rf "$DST/$item"
    cp -r "$SRC/$item" "$DST/$item"
  done
  cp -f "$SRC"/*.json "$DST/" 2>/dev/null || true
fi
echo "Sincronizado: $SRC -> $DST"
