FROM node:24-alpine

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
RUN pnpm install --frozen-lockfile --ignore-workspace --prod

# Copy source
COPY src ./src

# Default env (override at runtime)
ENV MAIDEO_API_BASE=https://api.maideo.fr/public/agent
ENV MAIDEO_AGENT_NAME=maideo-mcp-docker

# MCP servers communicate over stdio — no port to expose.
ENTRYPOINT ["node", "src/index.js"]
