# syntax=docker/dockerfile:1

# --- build the server and the web app ---------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY web/package.json web/
RUN npm ci

COPY backend backend
COPY web web
RUN npm run build

# --- build nsjail, the sandbox that runs submitted code -----------------------
FROM debian:bookworm-slim AS nsjail

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    autoconf bison ca-certificates flex g++ gcc git libnl-route-3-dev \
    libprotobuf-dev libtool make pkg-config protobuf-compiler \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch 3.6 --recurse-submodules --shallow-submodules \
    https://github.com/google/nsjail.git /nsjail \
  && make -C /nsjail

# --- runtime image ------------------------------------------------------------
FROM node:22-bookworm-slim

# Compilers and interpreters for contest code, plus nsjail's runtime libraries.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    libnl-route-3-200 \
    libprotobuf32 \
    openjdk-17-jdk-headless \
    python3 \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

# Kotlin is optional: its compiler needs about 1 GB of memory per compile.
# Build with `--build-arg KOTLIN_VERSION=2.1.0` and run with ENABLE_KOTLIN=1.
ARG KOTLIN_VERSION=""
RUN if [ -n "$KOTLIN_VERSION" ]; then \
    apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && curl -fsSL -o /tmp/kotlinc.zip \
      "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" \
    && unzip -q /tmp/kotlinc.zip -d /opt \
    && rm -rf /tmp/kotlinc.zip /var/lib/apt/lists/*; \
  fi

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=3001
ENV RUNNER_MODE=nsjail
ENV RUNNER_WORK_DIR=/run/icpc

COPY package.json package-lock.json /app/
COPY backend/package.json /app/backend/
COPY web/package.json /app/web/
RUN cd /app && npm ci --omit=dev --workspace backend

COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/web/dist /app/web/dist
COPY --from=nsjail /nsjail/nsjail /usr/local/bin/nsjail
COPY backend/sandbox /app/sandbox

RUN chmod +x /app/sandbox/entrypoint.sh && mkdir -p data/rooms

EXPOSE 3001

# Starts as root to delegate a cgroup subtree, then drops to the `node` user.
ENTRYPOINT ["/app/sandbox/entrypoint.sh"]
CMD ["node", "dist/index.js"]
