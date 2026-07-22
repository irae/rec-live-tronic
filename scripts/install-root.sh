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
STREAMLINK=${REC_LIVE_STREAMLINK_BIN:-/usr/local/bin/streamlink}
MIN_FREE_KIB=1048576
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MEDIA_USER=
DEPS_ARTIFACT=
WEB_ARTIFACT=
RECONCILER_ARTIFACT=
FORCE=false

usage() {
  cat <<'EOF'
Usage: install-root.sh [--deps-artifact TARBALL] [--web-artifact TARBALL] [--reconciler-artifact TARBALL] [--media-user USER] [--force]

Run as root to install three release packages. Auto-discovers rec-live-tronic-{deps,web,reconciler}.tar.gz
beside the script, or accept explicit artifact paths. The optional media user receives read/write
access through rec-media; omit it to keep media private. The script never installs packages,
changes sudo/polkit, or changes networking.
EOF
}
log() { printf '%s\n' "==> $*"; }
die() { printf '%s\n' "install-root.sh: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --deps-artifact) [ "$#" -ge 2 ] || die "--deps-artifact needs a tarball path"; DEPS_ARTIFACT=$2; shift 2 ;;
    --web-artifact) [ "$#" -ge 2 ] || die "--web-artifact needs a tarball path"; WEB_ARTIFACT=$2; shift 2 ;;
    --reconciler-artifact) [ "$#" -ge 2 ] || die "--reconciler-artifact needs a tarball path"; RECONCILER_ARTIFACT=$2; shift 2 ;;
    --media-user) [ "$#" -ge 2 ] || die "--media-user needs a user"; MEDIA_USER=$2; shift 2 ;;
    --force) FORCE=true; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must be run as root"
for command_name in awk basename chown chmod cp curl df diff dirname find getent grep groupadd head id install ln loginctl mv readlink rm runuser sed sleep stat systemctl systemd-run tail tar uname useradd usermod; do require_command "$command_name"; done
[ -x "$NODE" ] || die "missing Node executable: $NODE"

# Auto-discover artifacts if not provided
if [ -z "$DEPS_ARTIFACT" ]; then DEPS_ARTIFACT="$SCRIPT_DIR/rec-live-tronic-deps.tar.gz"; fi
if [ -z "$WEB_ARTIFACT" ]; then WEB_ARTIFACT="$SCRIPT_DIR/rec-live-tronic-web.tar.gz"; fi
if [ -z "$RECONCILER_ARTIFACT" ]; then RECONCILER_ARTIFACT="$SCRIPT_DIR/rec-live-tronic-reconciler.tar.gz"; fi

[ -f "$DEPS_ARTIFACT" ] || die "missing deps artifact: $DEPS_ARTIFACT"
[ -f "$WEB_ARTIFACT" ] || die "missing web artifact: $WEB_ARTIFACT"
[ -f "$RECONCILER_ARTIFACT" ] || die "missing reconciler artifact: $RECONCILER_ARTIFACT"

log "preflight: host dependencies and capacity"
[ -x "$STREAMLINK" ] || die "missing Streamlink executable: $STREAMLINK"
streamlink_version=$("$STREAMLINK" --version 2>&1) || die "Streamlink could not run: $STREAMLINK"
log "using $streamlink_version"
if command -v sqlite3 >/dev/null 2>&1; then sqlite3 ':memory:' 'pragma journal_mode=WAL; select 1;' >/dev/null || log "warning: SQLite CLI diagnostic failed; the application uses better-sqlite3"; else log "warning: sqlite3 CLI is unavailable; database backup commands will not work"; fi
systemctl --version | awk 'NR==1 { if ($2 + 0 < 250) exit 1 }' || log "warning: systemd is older than the tested version"
systemd-run --help | grep -q -- '--collect' || log "warning: systemd-run does not advertise --collect"
available_kib=$(df -Pk /srv | awk 'NR==2 { print $4 }')
[ "$available_kib" -ge "$MIN_FREE_KIB" ] || log "warning: less than ${MIN_FREE_KIB} KiB free for recordings"
[ -z "$MEDIA_USER" ] || getent passwd "$MEDIA_USER" >/dev/null || die "unknown media user: $MEDIA_USER"

first_unsafe_path() { find "$1" -xdev ! -type l \( ! -user root -o -perm /022 \) -print -quit; }
root_owned_tree() { offender=$(first_unsafe_path "$1"); [ -z "$offender" ] || die "non-root-owned or group/world-writable path: $offender"; }

log "create service account and groups"
getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"
getent passwd "$SERVICE_USER" >/dev/null || useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --comment 'rec-live-tronic service' "$SERVICE_USER"
getent group "$MEDIA_GROUP" >/dev/null || groupadd --system "$MEDIA_GROUP"
[ -z "$MEDIA_USER" ] || usermod -a -G "$MEDIA_GROUP" "$MEDIA_USER"
service_uid=$(id -u "$SERVICE_USER")

log "create configuration and application paths"
install -d -o root -g root -m 0755 "$PREFIX"
install -d -o root -g "$SERVICE_GROUP" -m 0750 "$CONFIG_DIR"
install -d -o "$SERVICE_USER" -g "$MEDIA_GROUP" -m 0770 "$DATA_DIR" "$DATA_DIR/cookies"
install -d -o "$SERVICE_USER" -g "$MEDIA_GROUP" -m 2770 "$RECORDINGS_DIR"

log "extract and install deps package"
deps_stage="$PREFIX/.deps.new.$$"
trap 'rm -rf "$deps_stage"' EXIT HUP INT TERM
install -d -o root -g root -m 0755 "$deps_stage"
tar -xzf "$DEPS_ARTIFACT" -C "$deps_stage"
chown -R root:root "$deps_stage/deps"; chmod -R go-w "$deps_stage/deps"
root_owned_tree "$deps_stage/deps"
if [ -e "$PREFIX/deps" ] && ! diff -qr "$deps_stage/deps" "$PREFIX/deps" >/dev/null; then
  [ "$FORCE" = true ] || die "existing deps differ; rerun with --force to replace it"
  rm -rf "$PREFIX/deps"
fi
if [ ! -e "$PREFIX/deps" ]; then
  mv "$deps_stage/deps" "$PREFIX/deps"
fi
rm -rf "$deps_stage"
trap - EXIT HUP INT TERM

log "verify packaged Node ABI compatibility"
node_version=$("$NODE" --version)
node_abi=$("$NODE" -p 'process.versions.modules')
"$NODE" -e "require('$PREFIX/deps/node_modules/better-sqlite3')" >/dev/null 2>&1 || die "packaged better-sqlite3 native binding cannot load (ABI mismatch with host Node $node_version)"

log "extract and install web package"
web_stage="$PREFIX/.web.new.$$"
trap 'rm -rf "$web_stage"' EXIT HUP INT TERM
install -d -o root -g root -m 0755 "$web_stage"
tar -xzf "$WEB_ARTIFACT" -C "$web_stage"
chown -R root:root "$web_stage/web"; chmod -R go-w "$web_stage/web"
root_owned_tree "$web_stage/web"
if [ -e "$PREFIX/web" ] && ! diff -qr "$web_stage/web" "$PREFIX/web" >/dev/null; then
  [ "$FORCE" = true ] || die "existing web differs; rerun with --force to replace it"
  rm -rf "$PREFIX/web"
fi
if [ ! -e "$PREFIX/web" ]; then
  mv "$web_stage/web" "$PREFIX/web"
fi
rm -rf "$web_stage"
if [ ! -f "$CONFIG_DIR/rec-live-tronic.env" ]; then
  cp "$PREFIX/web/.env.example" "$CONFIG_DIR/rec-live-tronic.env"
  chown root:$SERVICE_GROUP "$CONFIG_DIR/rec-live-tronic.env"
  chmod 0640 "$CONFIG_DIR/rec-live-tronic.env"
fi
trap - EXIT HUP INT TERM

log "extract and install reconciler package"
reconciler_stage="$PREFIX/.reconciler.new.$$"
trap 'rm -rf "$reconciler_stage"' EXIT HUP INT TERM
install -d -o root -g root -m 0755 "$reconciler_stage"
tar -xzf "$RECONCILER_ARTIFACT" -C "$reconciler_stage"
chown -R root:root "$reconciler_stage/reconciler"; chmod -R go-w "$reconciler_stage/reconciler"
root_owned_tree "$reconciler_stage/reconciler"
if [ -e "$PREFIX/reconciler" ] && ! diff -qr "$reconciler_stage/reconciler" "$PREFIX/reconciler" >/dev/null; then
  [ "$FORCE" = true ] || die "existing reconciler differs; rerun with --force to replace it"
  rm -rf "$PREFIX/reconciler"
fi
if [ ! -e "$PREFIX/reconciler" ]; then
  mv "$reconciler_stage/reconciler" "$PREFIX/reconciler"
fi
rm -rf "$reconciler_stage"
trap - EXIT HUP INT TERM

log "create node_modules symlinks"
ln -sfn ../deps/node_modules "$PREFIX/web/node_modules"
ln -sfn ../deps/node_modules "$PREFIX/reconciler/node_modules"

log "install hardened systemd units"
for unit in "$SERVICE-api.service" "$SERVICE-reconciler.service" "$SERVICE-reconciler.timer"; do
  source_file=""
  case "$unit" in
    "$SERVICE-api.service") source_file="$PREFIX/web/systemd/$unit" ;;
    *) source_file="$PREFIX/reconciler/systemd/$unit" ;;
  esac
  sed "s/@SERVICE_UID@/$service_uid/g" "$source_file" > "$UNIT_DIR/$unit.new"
  chown root:root "$UNIT_DIR/$unit.new"; chmod 0644 "$UNIT_DIR/$unit.new"; mv -f "$UNIT_DIR/$unit.new" "$UNIT_DIR/$unit"
done

log "enable dedicated user manager and verify its user bus"
loginctl enable-linger "$SERVICE_USER"; systemctl start "user@${service_uid}.service"
run_user_bus() { runuser -u "$SERVICE_USER" -- env "XDG_RUNTIME_DIR=/run/user/$service_uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$service_uid/bus" "$@"; }
probe="rec-live-tronic-install-probe-${service_uid}"
run_user_bus systemd-run --user --quiet --collect --unit "$probe" /bin/true
run_user_bus systemctl --user stop "$probe" >/dev/null 2>&1 || true

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

private_socket=$(sed -n 's/^REC_LIVE_PRIVATE_SOCKET=//p' "$CONFIG_DIR/rec-live-tronic.env" | tail -n 1); private_socket=${private_socket:-/run/rec-live-tronic/api.sock}
wait_for_private_socket() {
  socket_attempt=0
  while [ "$socket_attempt" -lt 30 ] && [ ! -S "$private_socket" ]; do sleep 1; socket_attempt=$((socket_attempt + 1)); done
  [ -S "$private_socket" ]
}

log "reload, enable, and start API before reconciliation"
systemctl daemon-reload; systemctl enable "$SERVICE-api.service"; systemctl restart "$SERVICE-api.service"
wait_for_private_socket || die "private API socket was not created: $private_socket"
systemctl enable --now "$SERVICE-reconciler.timer"

log "post-install verification"
systemctl is-active --quiet "$SERVICE-api.service"; systemctl is-active --quiet "$SERVICE-reconciler.timer"
test "$(stat -c '%U:%G %a' "$DATA_DIR")" = "$SERVICE_USER:$MEDIA_GROUP 770" || die "incorrect data directory mode"
test "$(stat -c '%U:%G %a' "$DATA_DIR/cookies")" = "$SERVICE_USER:$MEDIA_GROUP 770" || die "incorrect cookies directory mode"
test "$(stat -c '%U:%G %a' "$RECORDINGS_DIR")" = "$SERVICE_USER:$MEDIA_GROUP 2770" || die "incorrect recordings directory mode"
if ! wait_for_private_socket; then
  systemctl --no-pager --full status "$SERVICE-api.service" >&2 || true
  command -v journalctl >/dev/null 2>&1 && journalctl --no-pager -u "$SERVICE-api.service" -n 100 >&2 || true
  die "private API socket was not created: $private_socket"
fi
if ! curl --fail --silent --show-error --unix-socket "$private_socket" http://localhost/health >/dev/null; then
  systemctl --no-pager --full status "$SERVICE-api.service" >&2 || true
  command -v journalctl >/dev/null 2>&1 && journalctl --no-pager -u "$SERVICE-api.service" -n 100 >&2 || true
  die "private API socket health check failed: $private_socket"
fi
if ! systemctl start "$SERVICE-reconciler.service"; then
  systemctl --no-pager --full status "$SERVICE-reconciler.service" >&2 || true
  command -v journalctl >/dev/null 2>&1 && journalctl --no-pager -u "$SERVICE-reconciler.service" -n 100 >&2 || true
  die "reconciler verification failed"
fi
if systemctl is-failed --quiet "$SERVICE-reconciler.service"; then die "reconciler verification failed"; fi
run_user_bus systemctl --user list-units --all --no-legend >/dev/null
host=$(sed -n 's/^REC_LIVE_HOST=//p' "$CONFIG_DIR/rec-live-tronic.env" | tail -n 1); host=${host:-0.0.0.0}
port=$(sed -n 's/^REC_LIVE_PORT=//p' "$CONFIG_DIR/rec-live-tronic.env" | tail -n 1); port=${port:-8787}
health_host=$host; [ "$health_host" = 0.0.0.0 ] && health_host=127.0.0.1
curl --fail --silent --show-error "http://${health_host}:${port}/health" >/dev/null || die "health check failed (configured listener: $host:$port)"
systemctl list-timers "$SERVICE-reconciler.timer" --no-pager >/dev/null
log "installation complete: /opt/rec-live-tronic/{deps,web,reconciler}; listener configured as $host:$port"
