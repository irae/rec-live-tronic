# rec-live-tronic

`rec-live-tronic` is a curl-first YouTube live recorder. Phase 0 records
append-safe transport streams through Streamlink and systemd; the current
bootstrap provides the Node/TypeScript runtime foundation and health endpoint.

## Requirements

- Node.js 24.x and npm (the service rejects other Node majors at startup)
- Debian 13 x86-64 for release artifacts
- Docker with Buildx to create a target-host release artifact

Install dependencies on the platform where they will run. In particular, do
not copy `node_modules` built on macOS into a Debian release: `better-sqlite3`
contains a native binary.

```sh
npm ci
npm run build
npm test
```

For a local development configuration, copy `.env.example`, adjust its paths
to directories you own, then start the compiled server with those variables:

```sh
npm run build
REC_LIVE_DATA_DIR="$PWD/.local/state" \
REC_LIVE_RECORDINGS_DIR="$PWD/.local/recordings" \
REC_LIVE_PRIVATE_SOCKET="$PWD/.local/run/api.sock" \
npm start
```

The public listener defaults to `0.0.0.0:8787`; selecting a different valid
listen address is allowed. Network exposure, firewalls, reverse proxies, and
Tailscale remain deployment decisions. Check liveness without exposing cookie
or filesystem details:

```sh
curl http://127.0.0.1:8787/health
```

The health response has independent `process`, `sqlite`, `recordings`, and
`dependencies` checks; the dependency check verifies that the configured
Streamlink executable is accessible. Any failed check returns HTTP 503. API failures use a
stable JSON envelope such as `{"error":{"code":"NOT_FOUND","message":"Route not found"}}`.

## Phase 0 curl API

Cookie uploads take a `name` and one file. Responses never include cookie
contents or filesystem paths. Recording times are RFC 3339 instants with an
explicit offset; supported qualities are `best`, `1080p`, `720p` (default),
`480p`, `360p`, and `worst`.

```sh
curl http://127.0.0.1:8787/health
curl -F 'name=primary' -F 'file=@cookies.txt' http://127.0.0.1:8787/cookies
curl http://127.0.0.1:8787/cookies
curl -X DELETE http://127.0.0.1:8787/cookies/cookie-REPLACE_ME

curl -X POST http://127.0.0.1:8787/recordings \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=example","title":"Live show","start_at":"2026-07-21T20:00:00Z","stop_at":"2026-07-21T22:00:00Z","quality":"720p"}'
curl 'http://127.0.0.1:8787/recordings?status=scheduled'
curl http://127.0.0.1:8787/recordings/rec-REPLACE_ME
curl -X PATCH http://127.0.0.1:8787/recordings/rec-REPLACE_ME \
  -H 'content-type: application/json' -d '{"stop_at":"2026-07-21T22:30:00Z"}'
curl -X DELETE http://127.0.0.1:8787/recordings/rec-REPLACE_ME

# Validation errors are structured and safe to show in scripts.
curl -X POST http://127.0.0.1:8787/recordings -H 'content-type: application/json' \
  -d '{"url":"http://example.com","title":"bad","start_at":"2026-07-21T22:00:00Z","stop_at":"2026-07-21T20:00:00Z"}'
```

Cancelling is durable before the API asks systemd to stop a live unit. A live
`stop_at` update likewise persists before refreshing the systemd safety cap;
the reconciler will converge if that immediate action cannot be confirmed.

## Configuration

`.env.example` documents all non-secret settings. The important defaults are:

- `REC_LIVE_HOST=0.0.0.0`, `REC_LIVE_PORT=8787`
- private data under `/var/lib/rec-live-tronic`
- recordings under `/srv/rec-live-tronic/recordings`
- private API socket at `/run/rec-live-tronic/api.sock`
- root-managed Streamlink at `/usr/local/bin/streamlink`

The database migration and reconciler commands are intentionally reserved for
the next Phase 0 blocks; they currently report that the feature is unavailable.

## Deployment release build

Docker is only for producing the Debian x86-64 deployment artifact. Day-to-day
development and all ordinary build/test work use the bare-metal Node/npm steps
above.

Build the release on Docker's `linux/amd64` platform:

```sh
scripts/build-release.sh
```

It uses a digest-pinned `node:24-trixie` builder, cleanly installs dependencies,
runs the functional suites, loads the native SQLite binding, and writes a
tarball, detached SHA-256 file, and sidecar manifest to `release/`. The
artifact contains only compiled code, production dependencies, migrations,
systemd files, package metadata, and the root installer—never source tests or
`.env` files. Verify a generated artifact before transfer:

```sh
cd release
sha256sum -c rec-live-tronic-*-linux-amd64.tar.gz.sha256
```

## Target-host installation

Docker is only used to build the release; target-host development and runtime
are bare metal. Before installation, the operator must provision (or verify)
Node 24 matching the release manifest, SQLite CLI, and root-owned Streamlink
8.4.0 at `/usr/local/bin/streamlink`. Its resolved target must live under
root-owned `/opt/pipx`. The installer deliberately does not install packages,
compile native modules, configure a firewall/Tailscale, or change sudoers or
polkit.

Verify the transferred artifact, extract it into a root-owned directory, and
run its installer as root. Add the normal SSH/SFTP user to `rec-media` only if
that account needs direct, read-only media access.

```sh
sha256sum -c rec-live-tronic-0.1.0-linux-amd64.tar.gz.sha256
sudo tar -xzf rec-live-tronic-0.1.0-linux-amd64.tar.gz
cd rec-live-tronic-0.1.0
sudo scripts/install-root.sh --media-user irae
```

Use the real account name as one argument (for example `--media-user irae`);
omit the option to keep recordings available only to the service account. The
installer preflights the manifest, native `better-sqlite3` load, exact Node ABI,
Streamlink, SQLite, systemd capabilities, free space, and release ownership.
It then creates the non-login `rec-live-tronic` account, enables its lingering
user manager, proves its user-bus transient-unit control, installs root-owned
versioned releases below `/opt/rec-live-tronic`, and creates these paths:

- `/etc/rec-live-tronic/rec-live-tronic.env` — root-owned runtime configuration.
- `/var/lib/rec-live-tronic` and `cookies/` — private `0700` service state.
- `/srv/rec-live-tronic/recordings` — `rec-live-tronic:rec-media`, mode `2750`.
- `/run/rec-live-tronic` — systemd-created API runtime directory.

After the first installation, edit `/etc/rec-live-tronic/rec-live-tronic.env`
and restart the API to set a listener other than the default `0.0.0.0:8787`.
The installer does not overwrite an existing configuration file on later runs. Check the
services and the private socket after installation:

```sh
systemctl status rec-live-tronic-api.service rec-live-tronic-reconciler.timer
systemctl list-timers rec-live-tronic-reconciler.timer
curl http://127.0.0.1:8787/health
sudo -u rec-live-tronic \
  env XDG_RUNTIME_DIR=/run/user/$(id -u rec-live-tronic) \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u rec-live-tronic)/bus \
  systemctl --user list-units --all
```

## Upgrade and rollback

Back up SQLite before every upgrade because schema migrations are forward-only.
Stop the API briefly for a consistent backup, then restart it:

```sh
systemctl stop rec-live-tronic-api.service
sqlite3 /var/lib/rec-live-tronic/rec-live-tronic.sqlite '.backup /root/rec-live-tronic-before-upgrade.sqlite'
systemctl start rec-live-tronic-api.service
```

Verify and extract the next release, then run its installer. It installs a new
root-owned `/opt/rec-live-tronic/releases/<version>` tree, migrates the
database as the service account, atomically repoints `current`, and restarts
the API and timer while retaining every prior release tree.

```sh
cd rec-live-tronic-NEXT_VERSION
sudo scripts/install-root.sh
curl http://127.0.0.1:8787/health
```

Application-code rollback can repoint `current` to a retained release and
restart the API/timer, but it cannot reverse an already-applied migration.
Restore the explicit SQLite backup only when the release’s migration history is
compatible with that database snapshot.
