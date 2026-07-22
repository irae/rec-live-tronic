#!/bin/sh
set -eu

# Deployment packaging only. Use npm ci, npm run build, and npm test directly
# for normal development.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir=${REC_LIVE_RELEASE_DIR:-"$repo_root/release"}
revision=$(git -C "$repo_root" rev-parse HEAD)
image="rec-live-tronic-build:${revision}"
mkdir -p "$output_dir"

docker buildx build \
  --platform linux/amd64 \
  --file "$repo_root/Dockerfile.build" \
  --target release \
  --build-arg "GIT_REVISION=$revision" \
  --load \
  --tag "$image" \
  "$repo_root"
docker run --rm --platform linux/amd64 -v "$output_dir:/out" "$image" /out
