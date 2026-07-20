#!/usr/bin/env bash
# Sincroniza o plugin do repositório para a pasta de plugins do Ulanzi Studio.
# node_modules é preservado (não é copiado nem apagado).
#
# Também preserva os arquivos que o plugin gera em execução:
#   - plugin/error.log       (log do plugin instalado)
#   - plugin/ratelimit.json  (cooldown do rate limit; apagá-lo faz o plugin
#                             voltar a chamar a API durante um bloqueio)
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

# Arquivos gerados em runtime pelo plugin instalado — nunca copiar nem apagar.
RUNTIME_FILES="error.log ratelimit.json"

if command -v rsync >/dev/null 2>&1; then
  args=(-a --delete --exclude node_modules --exclude '*.log')
  for f in $RUNTIME_FILES; do args+=(--exclude "$f"); done
  rsync "${args[@]}" "$SRC/" "$DST/"
else
  # Fallback sem rsync. Um `rm -rf plugin` apagaria o log e o ratelimit.json do
  # Studio, então preservamos esses arquivos e os devolvemos após a cópia.
  TMP="$(mktemp -d)"
  for f in $RUNTIME_FILES; do
    [ -f "$DST/plugin/$f" ] && cp "$DST/plugin/$f" "$TMP/$f"
  done

  for item in manifest.json package.json plugin property-inspector libs assets; do
    rm -rf "$DST/$item"
    cp -r "$SRC/$item" "$DST/$item"
  done
  cp -f "$SRC"/*.json "$DST/" 2>/dev/null || true

  # Descarta as cópias vindas do repositório e devolve os originais do Studio.
  for f in $RUNTIME_FILES; do
    rm -f "$DST/plugin/$f"
    [ -f "$TMP/$f" ] && cp "$TMP/$f" "$DST/plugin/$f"
  done
  rm -rf "$TMP"
fi
echo "Sincronizado: $SRC -> $DST"
