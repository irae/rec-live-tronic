#!/bin/sh
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022

SERVICE=rec-live-tronic
SERVICE_USER=rec-live-tronic
SERVICE_GROUP=rec-live-tronic
MEDIA_GROUP=rec-media
PREFIX=/opt/rec-live-tronic
CONFIG_DIR=/etc/rec-live-tronic
DATA_DIR=/var/lib/rec-live-tronic
RECORDINGS_DIR=/srv/rec-live-tronic/recordings
UNIT_DIR=/etc/systemd/system
NODE=/usr/local/bin/node
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WEB_ARTIFACT=
RECONCILER_ARTIFACT=
DEPS_ARTIFACT=

usage() {
  cat <<'EOF'
Usage: deploy-fast.sh [--web-artifact PATH] [--reconciler-artifact PATH] [--deps-artifact PATH]

Fast code-only redeploy: update web and/or reconciler packages without touching deps
unless package-lock.json changed. At least one of --web-artifact or --reconciler-artifact required.
EOF
}
log() { printf '%s\n' "==> $*"; }
die() { printf '%s\n' "deploy-fast.sh: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --web-artifact) [ "$#" -ge 2 ] || die "--web-artifact needs a tarball path"; WEB_ARTIFACT=$2; shift 2 ;;
    --reconciler-artifact) [ "$#" -ge 2 ] || die "--reconciler-artifact needs a tarball path"; RECONCILER_ARTIFACT=$2; shift 2 ;;
    --deps-artifact) [ "$#" -ge 2 ] || die "--deps-artifact needs a tarball path"; DEPS_ARTIFACT=$2; shift 2 ;;
    --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must be run as root"
[ -n "$WEB_ARTIFACT" ] || [ -n "$RECONCILER_ARTIFACT" ] || die "at least one of --web-artifact or --reconciler-artifact required"

for command_name in awk basename chown chmod cp cmp curl diff dirname find getent grep head id install ln mv readlink rm runuser sed sleep stat systemctl tail tar uname; do require_command "$command_name"; done
[ -x "$NODE" ] || die "missing Node executable: $NODE"

first_unsafe_path() { find "$1" -xdev ! -type l \( ! -user root -o -perm /022 \) -print -quit; }
root_owned_tree() { offender=$(first_unsafe_path "$1"); [ -z "$offender" ] || die "non-root-owned or group/world-writable path: $offender"; }

service_uid=$(id -u "$SERVICE_USER" 2>/dev/null || echo "")
[ -n "$service_uid" ] || die "service user $SERVICE_USER not found"

if [ -n "$DEPS_ARTIFACT" ]; then
  log "check if dependencies changed"
  temp_lock=$(mktemp)
  trap 'rm -f "$temp_lock"' EXIT
  tar -xzf "$DEPS_ARTIFACT" -O deps/package-lock.json > "$temp_lock"
  if [ -f "$PREFIX/deps/package-lock.json" ] && cmp -s "$temp_lock" "$PREFIX/deps/package-lock.json"; then
    log "dependencies unchanged; skipping deps replacement"
  else
    log "dependencies changed; installing deps package"
    deps_stage="$PREFIX/.deps.new.$$"
    trap 'rm -rf "$temp_lock" "$deps_stage"' EXIT
    install -d -o root -g root -m 0755 "$deps_stage"
    tar -xzf "$DEPS_ARTIFACT" -C "$deps_stage"
    chown -R root:root "$deps_stage/deps"; chmod -R go-w "$deps_stage/deps"
    root_owned_tree "$deps_stage/deps"
    if [ -e "$PREFIX/deps" ]; then rm -rf "$PREFIX/deps"; fi
    mv "$deps_stage/deps" "$PREFIX/deps"
  fi
  trap 'rm -f "$temp_lock"' EXIT
fi

if [ -n "$WEB_ARTIFACT" ]; then
  log "installing web package"
  web_stage="$PREFIX/.web.new.$$"
  trap 'rm -rf "$web_stage"' EXIT
  install -d -o root -g root -m 0755 "$web_stage"
  tar -xzf "$WEB_ARTIFACT" -C "$web_stage"
  chown -R root:root "$web_stage/web"; chmod -R go-w "$web_stage/web"
  root_owned_tree "$web_stage/web"
  if [ -e "$PREFIX/web" ]; then rm -rf "$PREFIX/web"; fi
  mv "$web_stage/web" "$PREFIX/web"
  ln -sfn ../deps/node_modules "$PREFIX/web/node_modules"

  sed "s/@SERVICE_UID@/$service_uid/g" "$PREFIX/web/systemd/$SERVICE-api.service" > "$UNIT_DIR/$SERVICE-api.service.new"
  chown root:root "$UNIT_DIR/$SERVICE-api.service.new"; chmod 0644 "$UNIT_DIR/$SERVICE-api.service.new"
  mv -f "$UNIT_DIR/$SERVICE-api.service.new" "$UNIT_DIR/$SERVICE-api.service"

  log "migrate SQLite with private service umask"
  (
    set --
    while IFS= read -r config_line || [ -n "$config_line" ]; do
      case "$config_line" in
        ''|'#'*) ;;
        REC_LIVE_[A-Z_]*=*) set -- "$@" "$config_line" ;;
        *) die "unsupported line in $CONFIG_DIR/rec-live-tronic.env" ;;
      esac
    done < "$CONFIG_DIR/rec-live-tronic.env"
    runuser -u "$SERVICE_USER" -- env "$@" sh -c "umask 077; cd '$PREFIX/web'; exec '$NODE' dist/db/migrate.js"
  )

  log "reload and restart API service"
  systemctl daemon-reload; systemctl restart "$SERVICE-api.service"

  private_socket=$(sed -n 's/^REC_LIVE_PRIVATE_SOCKET=//p' "$CONFIG_DIR/rec-live-tronic.env" | tail -n 1); private_socket=${private_socket:-/run/rec-live-tronic/api.sock}
  socket_attempt=0
  while [ "$socket_attempt" -lt 30 ] && [ ! -S "$private_socket" ]; do sleep 1; socket_attempt=$((socket_attempt + 1)); done
  [ -S "$private_socket" ] || die "private API socket was not created: $private_socket"

  curl --fail --silent --show-error --unix-socket "$private_socket" http://localhost/health >/dev/null || die "private API socket health check failed: $private_socket"
fi

if [ -n "$RECONCILER_ARTIFACT" ]; then
  log "installing reconciler package"
  reconciler_stage="$PREFIX/.reconciler.new.$$"
  trap 'rm -rf "$reconciler_stage"' EXIT
  install -d -o root -g root -m 0755 "$reconciler_stage"
  tar -xzf "$RECONCILER_ARTIFACT" -C "$reconciler_stage"
  chown -R root:root "$reconciler_stage/reconciler"; chmod -R go-w "$reconciler_stage/reconciler"
  root_owned_tree "$reconciler_stage/reconciler"
  if [ -e "$PREFIX/reconciler" ]; then rm -rf "$PREFIX/reconciler"; fi
  mv "$reconciler_stage/reconciler" "$PREFIX/reconciler"
  ln -sfn ../deps/node_modules "$PREFIX/reconciler/node_modules"

  for unit in "$SERVICE-reconciler.service" "$SERVICE-reconciler.timer"; do
    sed "s/@SERVICE_UID@/$service_uid/g" "$PREFIX/reconciler/systemd/$unit" > "$UNIT_DIR/$unit.new"
    chown root:root "$UNIT_DIR/$unit.new"; chmod 0644 "$UNIT_DIR/$unit.new"
    mv -f "$UNIT_DIR/$unit.new" "$UNIT_DIR/$unit"
  done

  log "reload reconciler systemd units (no restart; timer-driven)"
  systemctl daemon-reload
fi

log "deployment complete"
