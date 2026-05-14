FROM node:22-bookworm-slim AS build

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci

COPY backend/ ./
RUN npm run build

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    openjdk-17-jdk-headless \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=3001

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/backend/dist ./dist
COPY frontend /app/frontend

RUN mkdir -p data/rooms

EXPOSE 3001

CMD ["node", "dist/index.js"]
