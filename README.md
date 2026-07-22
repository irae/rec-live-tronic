# rec-live-tronic

`rec-live-tronic` is a curl-first YouTube live recorder. Phase 0 records
append-safe transport streams through Streamlink and systemd.

## Requirements

- Node.js 24.x and npm (the service rejects other Node majors at startup).
- Docker with Buildx on the build host.
- Debian 13 x86-64, SQLite CLI, and root-managed Streamlink 8.4.0 on the
  target host.

## Target-host prerequisites

After extracting the verified release on Debian 13 x86-64, run these commands
as a sudo-capable operator. They install the exact Node version recorded by the
release, not merely any Node 24 release. The installer does not install these
dependencies for you.

```sh
cd /path/to/rec-live-tronic-0.1.0

sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl pipx sqlite3 xz-utils

NODE_VERSION=$(sed -n 's/.*"node_version": "\([^"]*\)".*/\1/p' manifest.json)
test -n "$NODE_VERSION"
cd /tmp
curl -fSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
curl -fSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
grep " node-$NODE_VERSION-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -
sudo tar -C /opt -xJf "node-$NODE_VERSION-linux-x64.tar.xz"
sudo ln -sfn "/opt/node-$NODE_VERSION-linux-x64" /usr/local/node
sudo ln -sfn /usr/local/node/bin/node /usr/local/bin/node
sudo ln -sfn /usr/local/node/bin/npm /usr/local/bin/npm
sudo ln -sfn /usr/local/node/bin/npx /usr/local/bin/npx

sudo env PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin \
  pipx install --python /usr/bin/python3 'streamlink==8.4.0'

/usr/local/bin/node --version
/usr/local/bin/npm --version
/usr/local/bin/streamlink --version
sqlite3 --version
```

The commands intentionally leave the human account's Streamlink installation
alone. The service uses only `/usr/local/bin/streamlink`, whose resolved target
must be under root-owned `/opt/pipx`.

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
curl http://127.0.0.1:8787/recordings/rec-REPLACE_ME/file  # VLC-openable URL for a finished recording

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

`npm run db:migrate` applies forward-only database migrations. `npm run
reconcile:once` runs one reconciliation tick; systemd owns its production
cadence.

## Deployment release build

Docker is only for producing the Debian x86-64 deployment artifacts. Day-to-day
development and all ordinary build/test work use the bare-metal Node/npm steps
above.

Build the release on Docker's `linux/amd64` platform:

```sh
scripts/build-release.sh
```

It uses a digest-pinned `node:24-trixie` builder, cleanly installs dependencies,
runs the functional suites, loads the native SQLite binding, and writes three
tarballs to `release/`: `rec-live-tronic-deps.tar.gz`, `rec-live-tronic-web.tar.gz`,
and `rec-live-tronic-reconciler.tar.gz`. Each contains only the files needed for
that deployment unit—dependencies, web application, or reconciler—never source tests
or `.env` files.

## Target-host installation

Docker is only used to build the release; target-host development and runtime
are bare metal. Before installation, the operator must provision (or verify)
Node 24, SQLite CLI, and root-owned Streamlink 8.4.0 at `/usr/local/bin/streamlink`.
Its resolved target must live under root-owned `/opt/pipx`. The installer
deliberately does not install packages, compile native modules, configure a
firewall/Tailscale, or change sudoers or polkit.

Transfer the three release artifacts to the target and run the installer as
root. Add the normal SSH/SFTP user to `rec-media` only if that account needs
direct read/write media access.

```sh
scp rec-live-tronic-*.tar.gz remote:/tmp/
ssh -t remote sudo /tmp/rec-live-tronic-web.tar.gz web/scripts/install-root.sh --force --media-user irae
```

Or use the automated `install-sheeta.sh` script (update `REMOTE_HOST` and
`REMOTE_USER` as needed):

```sh
scripts/install-sheeta.sh
```

Use the real account name as one argument (for example `--media-user irae`);
omit the option to keep recordings available only to the service account. The
installer preflights the native `better-sqlite3` load, Node ABI, Streamlink,
SQLite, systemd capabilities, free space, and release ownership.
It then creates the non-login `rec-live-tronic` account, enables its lingering
user manager, proves its user-bus transient-unit control, installs three
directories below `/opt/rec-live-tronic` (`deps`, `web`, `reconciler`), and
creates these paths:

- `/etc/rec-live-tronic/rec-live-tronic.env` — root-owned runtime configuration.
- `/var/lib/rec-live-tronic` and `cookies/` — `rec-live-tronic:rec-media`, mode `0770`.
- `/srv/rec-live-tronic/recordings` — `rec-live-tronic:rec-media`, mode `2770`.
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

## Current deployment (`irae-sheeta`)

- Release `0.1.0`, service account UID `998`, Node `v24.18.0`, Streamlink `8.4.0`.
- Listener: `0.0.0.0:8787` (default, unchanged). Reachable at
  `http://irae-sheeta.tailc9708.ts.net:8787` over Tailscale, or
  `http://<host-LAN-IP>:8787` from the home LAN.
- `irae` is a `rec-media` member: recordings, logs, and cookies under
  `/srv/rec-live-tronic/recordings` and `/var/lib/rec-live-tronic` are directly
  readable/writable over SSH, no `su` needed.
- Backup: `su -c 'sqlite3 /var/lib/rec-live-tronic/rec-live-tronic.sqlite ".backup /tmp/rec-live-tronic-backup.sqlite"'`
- Diagnostics: `curl http://127.0.0.1:8787/health`,
  `systemctl status rec-live-tronic-api.service rec-live-tronic-reconciler.timer`,
  `tail -f /srv/rec-live-tronic/recordings/<id>.log`.

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
