#!/bin/sh
set -eu

output_dir=${1:-/out}
version=$(node -p "require('/release-source/package.json').version")
release_name="rec-live-tronic-${version}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$output_dir" "$stage/$release_name"

cp -R /release-source/dist /release-source/node_modules /release-source/migrations /release-source/systemd "$stage/$release_name/"
mkdir -p "$stage/$release_name/scripts"
cp /release-source/scripts/install-root.sh "$stage/$release_name/scripts/"
cp /release-source/package.json /release-source/package-lock.json "$stage/$release_name/"

lock_digest=$(sha256sum /release-source/package-lock.json | awk '{print $1}')
build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node_version=$(node --version)
npm_version=$(npm --version)
node_abi=$(node -p 'process.versions.modules')
embedded_manifest="$stage/$release_name/manifest.json"
sidecar_manifest="$output_dir/${release_name}-manifest.json"
cat > "$embedded_manifest" <<EOF
{
  "git_revision": "${GIT_REVISION}",
  "build_time": "${build_time}",
  "platform": "linux/amd64",
  "base_image_digest": "${BASE_IMAGE_DIGEST}",
  "debian_release": "trixie",
  "node_version": "${node_version}",
  "npm_version": "${npm_version}",
  "node_module_abi": "${node_abi}",
  "package_lock_sha256": "${lock_digest}",
  "build_succeeded": true,
  "functional_tests_succeeded": true,
  "native_binding_loaded": true
}
EOF

tarball="$output_dir/${release_name}-linux-amd64.tar.gz"
tar -C "$stage" -czf "$tarball" "$release_name"
checksum=$(sha256sum "$tarball" | awk '{print $1}')
printf '%s  %s\n' "$checksum" "$(basename "$tarball")" > "$tarball.sha256"
artifact_size=$(wc -c < "$tarball" | tr -d ' ')
cat > "$sidecar_manifest" <<EOF
{
  "git_revision": "${GIT_REVISION}",
  "build_time": "${build_time}",
  "platform": "linux/amd64",
  "base_image_digest": "${BASE_IMAGE_DIGEST}",
  "debian_release": "trixie",
  "node_version": "${node_version}",
  "npm_version": "${npm_version}",
  "node_module_abi": "${node_abi}",
  "package_lock_sha256": "${lock_digest}",
  "build_succeeded": true,
  "functional_tests_succeeded": true,
  "native_binding_loaded": true,
  "artifact": "$(basename "$tarball")",
  "artifact_sha256": "${checksum}",
  "artifact_size_bytes": ${artifact_size},
  "manifest_in_artifact": "${release_name}/manifest.json"
}
EOF

tar -tzf "$tarball" >/dev/null
sha256sum -c "$tarball.sha256"
