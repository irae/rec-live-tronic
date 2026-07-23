#!/bin/sh
set -eu

# Personal one-command deploy to the owner's irae-sheeta host. NOT a generic
# tool: it targets a specific box and is intentionally left out of the README,
# which documents only the host-agnostic scp + ssh install-root.sh flow.
#
# Usage:
#   install-sheeta.sh                       Full deploy: push all three artifacts
#                                           and run a full provisioning install.
#   install-sheeta.sh --web [--deps ...]    Fast partial deploy: push and install
#                                           only the named piece(s). Accepts any
#                                           combination of --deps, --web, --reconciler.
#
# Override the target with REMOTE_HOST, REMOTE_USER, and MEDIA_USER env vars.

REMOTE_HOST=${REMOTE_HOST:-irae-sheeta}
REMOTE_USER=${REMOTE_USER:-irae}
MEDIA_USER=${MEDIA_USER:-irae}
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RELEASE_DIR="$ROOT_DIR/release"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"

DO_DEPS=false
DO_WEB=false
DO_RECONCILER=false
FULL=true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --deps) DO_DEPS=true; FULL=false; shift ;;
    --web) DO_WEB=true; FULL=false; shift ;;
    --reconciler) DO_RECONCILER=true; FULL=false; shift ;;
    *) printf '%s\n' "install-sheeta.sh: unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ "$FULL" = true ]; then DO_DEPS=true; DO_WEB=true; DO_RECONCILER=true; fi

# Collect the tarballs to ship, and the piece flags to hand install-root.sh.
uploads="$ROOT_DIR/scripts/install-root.sh"
piece_flags=""
add_piece() {
  name=$1
  tarball="$RELEASE_DIR/rec-live-tronic-$name.tar.gz"
  [ -f "$tarball" ] || { printf '%s\n' "missing release archive: $tarball" >&2; exit 1; }
  uploads="$uploads $tarball"
  [ "$FULL" = true ] || piece_flags="$piece_flags --$name"
}
[ "$DO_DEPS" = false ] || add_piece deps
[ "$DO_WEB" = false ] || add_piece web
[ "$DO_RECONCILER" = false ] || add_piece reconciler

# shellcheck disable=SC2086
scp $uploads "$REMOTE:/tmp/"

media_flag=""
[ "$FULL" = false ] || media_flag="--media-user ${MEDIA_USER}"
ssh -t "$REMOTE" "su -c 'chmod +x /tmp/install-root.sh && /tmp/install-root.sh ${piece_flags} ${media_flag}'"
