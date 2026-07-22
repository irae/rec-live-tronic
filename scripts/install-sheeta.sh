#!/bin/sh
set -eu

REMOTE_HOST=${REMOTE_HOST:-irae-sheeta}
REMOTE_USER=${REMOTE_USER:-irae}
MEDIA_USER=${MEDIA_USER:-irae}
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
ARCHIVE="$ROOT_DIR/release/rec-live-tronic-${VERSION}-linux-amd64.tar.gz"
CHECKSUM="$ARCHIVE.sha256"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"
REMOTE_RELEASE="/tmp/rec-live-tronic-${VERSION}"

[ -f "$ARCHIVE" ] || { printf '%s\n' "missing release archive: $ARCHIVE" >&2; exit 1; }
[ -f "$CHECKSUM" ] || { printf '%s\n' "missing release checksum: $CHECKSUM" >&2; exit 1; }

scp "$ARCHIVE" "$CHECKSUM" "$REMOTE:/tmp/"
ssh -t "$REMOTE" "su -c 'cd /tmp && sha256sum -c rec-live-tronic-${VERSION}-linux-amd64.tar.gz.sha256 && rm -rf ${REMOTE_RELEASE} && tar -xzf rec-live-tronic-${VERSION}-linux-amd64.tar.gz && cd ${REMOTE_RELEASE} && scripts/install-root.sh --force --media-user ${MEDIA_USER}'"
