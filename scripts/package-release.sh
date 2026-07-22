#!/bin/sh
set -eu

output_dir=${1:-/out}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$output_dir"

# deps package: node_modules and package-lock.json
mkdir -p "$stage/deps"
cp -R /release-source/node_modules /release-source/package-lock.json "$stage/deps/"
tar -C "$stage" -czf "$output_dir/rec-live-tronic-deps.tar.gz" "deps"

# web package: dist, migrations, package.json, .env.example, systemd service, install script
mkdir -p "$stage/web/systemd"
cp -R /release-source/dist /release-source/migrations "$stage/web/"
cp /release-source/package.json /release-source/.env.example "$stage/web/"
cp /release-source/systemd/rec-live-tronic-api.service "$stage/web/systemd/"
cp /release-source/scripts/install-root.sh "$stage/web/"
chmod 0755 "$stage/web/install-root.sh"
tar -C "$stage" -czf "$output_dir/rec-live-tronic-web.tar.gz" "web"

# reconciler package: dist, package.json, systemd service and timer
mkdir -p "$stage/reconciler/systemd"
cp -R /release-source/dist "$stage/reconciler/"
cp /release-source/package.json "$stage/reconciler/"
cp /release-source/systemd/rec-live-tronic-reconciler.service /release-source/systemd/rec-live-tronic-reconciler.timer "$stage/reconciler/systemd/"
tar -C "$stage" -czf "$output_dir/rec-live-tronic-reconciler.tar.gz" "reconciler"
