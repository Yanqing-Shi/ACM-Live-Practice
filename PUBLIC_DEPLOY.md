# Deploying ICPC Live

ICPC Live runs as one container: the server, the web app, and the sandbox that executes submitted code.

## Read this first

**The sandbox has not been run yet.** The executor, the nsjail configuration, the seccomp policy, and the container entrypoint are written and unit-tested, but they were developed on a machine without Docker. Until the checklist in [docs/sandbox.md](./docs/sandbox.md) passes on your host, treat the deployment as unsandboxed and only share it with people you trust.

Submitted code is arbitrary code. Even with the sandbox working, it shares the host's kernel, so:

- run it on a machine that holds nothing else you care about, or accept that risk on your own PC for people you know;
- keep the host's kernel updated;
- keep backups of the data volume somewhere else.

## What the host needs

- Linux with cgroup v2 (any current distribution; WSL2 works) and Docker with Compose.
- Permission to run a **privileged** container. nsjail creates namespaces and cgroups, which Docker's default profile forbids. Platforms that do not allow privileged containers (Render's Docker services, for example) cannot run the sandbox.
- About 2 GB of free memory for the default limits (two concurrent runs of 256 MB plus compilers).

## Start it

```sh
docker compose -f deploy/compose.yaml up -d --build
```

The app listens on `127.0.0.1:3001` only. Check it:

```sh
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/health/runners     # "executor": { "mode": "nsjail", "sandboxed": true }
```

Then run the sandbox checklist in [docs/sandbox.md](./docs/sandbox.md).

Settings go in a `deploy/.env` file or the shell environment: `ADMIN_TOKEN`, `RUN_MAX_CONCURRENT`, `RUN_TIME_LIMIT_MS`, `RUN_MEMORY_LIMIT_MB`, `ICPC_MEM_LIMIT` (container memory, default `3g`), and `KOTLIN_VERSION` plus `ENABLE_KOTLIN=1` to include Kotlin.

## Make it reachable

### Free: your own PC and a tunnel

This costs nothing and suits practice sessions, since the server only needs to be up while your team is practising.

```sh
# No account needed. The URL changes every time it starts.
cloudflared tunnel --url http://127.0.0.1:3001
```

Share the printed `https://….trycloudflare.com` URL. Teammates open it, enter a name, and join with the team code.

For a link that stays the same, Tailscale Funnel on a free personal account is an alternative:

```sh
tailscale funnel 3001
```

Neither tunnel has been tested with this app yet. Both carry WebSockets in principle; confirm with a three-person session before relying on one.

### A server with a domain

On a VPS, the bundled Caddy obtains a certificate and proxies HTTPS and WebSockets:

```sh
ICPC_DOMAIN=live.example.com docker compose -f deploy/compose.yaml --profile public up -d --build
```

Point the domain's DNS at the server and open ports 80 and 443. Any KVM-based VPS running a current Debian with Docker should work. Fly.io Machines reportedly lack full cgroup v2 support and would need a different sandbox setup.

## Data and backups

Rooms are JSON files in the `icpc-data` volume (`/app/backend/data/rooms`). Session tokens are stored only as hashes. Rooms nobody has touched for 30 days are deleted.

```sh
docker compose -f deploy/compose.yaml exec app tar -C /app/backend -czf - data > icpc-backup.tgz
```

## Running without the sandbox

For a private server where every user is trusted, the sandbox can be switched off explicitly:

```sh
RUNNER_MODE=direct RUNNER_ALLOW_UNSANDBOXED=1 NODE_ENV=production npm start
```

Code then runs with the server's own privileges and can read every room. Without `RUNNER_ALLOW_UNSANDBOXED=1` the server refuses to start in this configuration.
