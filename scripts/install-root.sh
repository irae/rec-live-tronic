#!/bin/sh
set -eu
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
RELEASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MEDIA_USER=
ARTIFACT=
FORCE=false

usage() {
  cat <<'EOF'
Usage: install-root.sh [--release-dir PATH] [--artifact TARBALL] [--media-user USER] [--force]

Run as root from an extracted, verified release directory. The optional media
user receives read-only access through rec-media; omit it to keep media private.
The script never installs packages, changes sudo/polkit, or changes networking.
EOF
}
log() { printf '%s\n' "==> $*"; }
die() { printf '%s\n' "install-root.sh: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-dir) [ "$#" -ge 2 ] || die "--release-dir needs a path"; RELEASE_DIR=$2; shift 2 ;;
    --artifact) [ "$#" -ge 2 ] || die "--artifact needs a tarball path"; ARTIFACT=$2; shift 2 ;;
    --media-user) [ "$#" -ge 2 ] || die "--media-user needs a user"; MEDIA_USER=$2; shift 2 ;;
    --force) FORCE=true; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must be run as root"
for command_name in awk basename chown chmod cp curl df diff dirname find getent grep groupadd head id install ln loginctl mv readlink rm runuser sed sha256sum sleep stat systemctl systemd-run tail uname useradd usermod; do require_command "$command_name"; done
[ -x "$NODE" ] || die "missing Node executable: $NODE"
RELEASE_DIR=$(CDPATH= cd -- "$RELEASE_DIR" && pwd)
[ -f "$RELEASE_DIR/manifest.json" ] || die "release manifest is missing"
[ -f "$RELEASE_DIR/package.json" ] || die "release package metadata is missing"
[ -d "$RELEASE_DIR/dist" ] && [ -d "$RELEASE_DIR/node_modules" ] && [ -d "$RELEASE_DIR/migrations" ] && [ -d "$RELEASE_DIR/systemd" ] || die "release contents are incomplete"

json_string() { sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\"[,]*[[:space:]]*$/\1/p" "$RELEASE_DIR/manifest.json" | head -n 1; }
json_true() { grep -Eq "^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*true[,]*[[:space:]]*$" "$RELEASE_DIR/manifest.json"; }
first_unsafe_path() { find "$1" -xdev ! -type l \( ! -user root -o -perm /022 \) -print -quit; }
root_owned_tree() { offender=$(first_unsafe_path "$1"); [ -z "$offender" ] || die "non-root-owned or group/world-writable path: $offender"; }

log "preflight: release manifest and target platform"
[ "$(json_string platform)" = linux/amd64 ] || die "release is not linux/amd64"
[ "$(uname -m)" = x86_64 ] || die "host is not x86-64"
json_true build_succeeded && json_true functional_tests_succeeded && json_true native_binding_loaded || die "manifest lacks successful build/test/native-binding evidence"
release_node=$(json_string node_version); release_abi=$(json_string node_module_abi)
[ -n "$release_node" ] && [ -n "$release_abi" ] || die "release manifest lacks Node metadata"
[ "$("$NODE" --version)" = "$release_node" ] || die "host Node $("$NODE" --version) does not match release $release_node"
[ "$("$NODE" -p 'process.versions.modules')" = "$release_abi" ] || die "host Node module ABI does not match release"
"$NODE" -e "require('$RELEASE_DIR/node_modules/better-sqlite3')" >/dev/null 2>&1 || die "packaged better-sqlite3 native binding cannot load"

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

version=$("$NODE" -p "require('$RELEASE_DIR/package.json').version")
case "$version" in ''|*[!A-Za-z0-9._-]*) die "unsafe package version" ;; esac
if [ -z "$ARTIFACT" ]; then ARTIFACT="$(dirname "$RELEASE_DIR")/rec-live-tronic-${version}-linux-amd64.tar.gz"; fi
if [ -f "$ARTIFACT" ] && [ -f "$ARTIFACT.sha256" ]; then
  artifact_dir=$(CDPATH= cd -- "$(dirname -- "$ARTIFACT")" && pwd)
  artifact_name=$(basename "$ARTIFACT")
  (cd "$artifact_dir" && sha256sum -c "${artifact_name}.sha256") || die "release checksum verification failed"
else
  log "warning: release tarball/checksum not found beside extracted release; skipping duplicate checksum verification"
fi
release_path="$PREFIX/releases/$version"; current_link="$PREFIX/current"

log "create service account and groups"
getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"
getent passwd "$SERVICE_USER" >/dev/null || useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --comment 'rec-live-tronic service' "$SERVICE_USER"
getent group "$MEDIA_GROUP" >/dev/null || groupadd --system "$MEDIA_GROUP"
[ -z "$MEDIA_USER" ] || usermod -a -G "$MEDIA_GROUP" "$MEDIA_USER"
service_uid=$(id -u "$SERVICE_USER")

log "install root-owned versioned release $version"
install -d -o root -g root -m 0755 "$PREFIX/releases"
if [ -e "$release_path" ] && ! diff -qr "$RELEASE_DIR" "$release_path" >/dev/null; then
  [ "$FORCE" = true ] || die "existing release $version differs; rerun with --force to replace it"
  rm -rf "$release_path"
fi
if [ ! -e "$release_path" ]; then
  staging="$PREFIX/releases/.${version}.new.$$"
  trap 'rm -rf "$staging"' EXIT HUP INT TERM
  install -d -o root -g root -m 0755 "$staging"
  cp -a "$RELEASE_DIR/." "$staging/"
  chown -R root:root "$staging"; chmod -R go-w "$staging"; mv "$staging" "$release_path"
  trap - EXIT HUP INT TERM
fi
root_owned_tree "$release_path"

log "create configuration and application paths"
install -d -o root -g "$SERVICE_GROUP" -m 0750 "$CONFIG_DIR"
[ -f "$CONFIG_DIR/rec-live-tronic.env" ] || install -o root -g "$SERVICE_GROUP" -m 0640 "$RELEASE_DIR/.env.example" "$CONFIG_DIR/rec-live-tronic.env"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$DATA_DIR" "$DATA_DIR/cookies"
install -d -o "$SERVICE_USER" -g "$MEDIA_GROUP" -m 2750 "$RECORDINGS_DIR"

log "install hardened systemd units"
for unit in "$SERVICE-api.service" "$SERVICE-reconciler.service" "$SERVICE-reconciler.timer"; do
  sed "s/@SERVICE_UID@/$service_uid/g" "$release_path/systemd/$unit" > "$UNIT_DIR/$unit.new"
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
  runuser -u "$SERVICE_USER" -- env "$@" sh -c "umask 077; cd '$release_path'; exec '$NODE' dist/db/migrate.js"
)

log "atomically select migrated release $version"
ln -sfn "$release_path" "$current_link.new"; mv -Tf "$current_link.new" "$current_link"

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
test "$(stat -c '%U:%G %a' "$DATA_DIR")" = "$SERVICE_USER:$SERVICE_GROUP 700" || die "incorrect data directory mode"
test "$(stat -c '%U:%G %a' "$DATA_DIR/cookies")" = "$SERVICE_USER:$SERVICE_GROUP 700" || die "incorrect cookies directory mode"
test "$(stat -c '%U:%G %a' "$RECORDINGS_DIR")" = "$SERVICE_USER:$MEDIA_GROUP 2750" || die "incorrect recordings directory mode"
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
log "installation complete: $current_link -> $release_path; listener configured as $host:$port"
