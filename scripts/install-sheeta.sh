#!/bin/sh
set -eu

REMOTE_HOST=${REMOTE_HOST:-irae-sheeta}
REMOTE_USER=${REMOTE_USER:-irae}
MEDIA_USER=${MEDIA_USER:-irae}
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RELEASE_DIR="$ROOT_DIR/release"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"
REMOTE_INSTALL_DIR="/tmp/rec-live-tronic-install-$$"

[ -f "$RELEASE_DIR/rec-live-tronic-deps.tar.gz" ] || { printf '%s\n' "missing release archive: $RELEASE_DIR/rec-live-tronic-deps.tar.gz" >&2; exit 1; }
[ -f "$RELEASE_DIR/rec-live-tronic-web.tar.gz" ] || { printf '%s\n' "missing release archive: $RELEASE_DIR/rec-live-tronic-web.tar.gz" >&2; exit 1; }
[ -f "$RELEASE_DIR/rec-live-tronic-reconciler.tar.gz" ] || { printf '%s\n' "missing release archive: $RELEASE_DIR/rec-live-tronic-reconciler.tar.gz" >&2; exit 1; }

scp "$RELEASE_DIR/rec-live-tronic-deps.tar.gz" "$RELEASE_DIR/rec-live-tronic-web.tar.gz" "$RELEASE_DIR/rec-live-tronic-reconciler.tar.gz" "$REMOTE:/tmp/"
ssh -t "$REMOTE" "su -c 'mkdir -p $REMOTE_INSTALL_DIR && cd $REMOTE_INSTALL_DIR && cp /tmp/rec-live-tronic-*.tar.gz . && tar -xzf rec-live-tronic-web.tar.gz && cd web && ./install-root.sh --force --media-user ${MEDIA_USER} --deps-artifact /tmp/rec-live-tronic-deps.tar.gz --web-artifact /tmp/rec-live-tronic-web.tar.gz --reconciler-artifact /tmp/rec-live-tronic-reconciler.tar.gz'"
