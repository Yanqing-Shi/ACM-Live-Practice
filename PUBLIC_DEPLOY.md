# Public Deployment

This repo can run as one public Node service: Express serves the frontend files, HTTP APIs, and WebSocket room traffic from the same origin.

## Important Safety Note

The runner executes user-submitted code. Do not run this as an open public service for untrusted users without sandboxing. The included Dockerfile installs compilers/interpreters for convenience, but it is not a contest-grade isolation boundary. For real public usage, add a separate Docker/firecracker runner, CPU/memory/file limits, authentication, and abuse controls.

## Local Production Check

From the repo root:

```powershell
cd backend
npm.cmd install
npm.cmd test
npm.cmd run build
npm.cmd start
```

Then open:

```text
http://localhost:3001
```

Health endpoints:

```text
http://localhost:3001/health
http://localhost:3001/health/runners
```

## Docker

Build from the repo root:

```powershell
docker build -t icpc-live .
```

Run:

```powershell
docker run --rm -p 3001:3001 -v icpc-live-data:/app/backend/data icpc-live
```

Open:

```text
http://localhost:3001
```

The Docker image includes C/C++, Python 3, and Java runners. Kotlin may show unavailable in `/health/runners` unless you extend the image with `kotlinc`.

## Render / Railway Style Hosting

Use a Web Service, not a static-only deployment, because the app needs WebSockets and backend room state.

## Render Blueprint

This repo includes `render.yaml`. After pushing the repo to GitHub:

1. In Render, choose **New > Blueprint**.
2. Connect this repository.
3. Render will create a Docker Web Service named `icpc-live`.
4. It will mount a persistent disk at `/app/backend/data`.
5. After deploy, share the generated `https://...onrender.com` URL.

That URL is the whole app. Teammates do not need to run anything locally.

Recommended settings:

```text
Runtime: Docker
Port: use the platform-provided PORT env var
Persistent disk / volume: mount to /app/backend/data
Health check path: /health
```

After deploy, open the service URL. The frontend automatically uses the same host for HTTPS and WebSocket traffic, so public connections use `wss://...`.

## Temporary Public Testing

For a short demo from your own machine, run the backend locally and expose port `3001` with a tunnel such as Cloudflare Tunnel or ngrok:

```powershell
cd backend
npm.cmd run build
npm.cmd start
```

Then point the tunnel at:

```text
http://localhost:3001
```

Share the tunnel URL. Do not use this for untrusted public code execution.

## Validation Before Public Sharing

Run the automated checks that are visible in this repo:

```powershell
cd backend
npm.cmd test
```

```powershell
cd vscode-extension
npm.cmd test
```

Compile-only extension check:

```powershell
cd vscode-extension
npm.cmd run compile
```

The backend test script includes runner health endpoint shape checks and static
checks for the Docker and Render deployment settings.
