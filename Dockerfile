# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Add labels for Docker Hub
LABEL org.opencontainers.image.title="Claude Agent MCP Server"
LABEL org.opencontainers.image.description="MCP server for AI agent team communication via Redis pub/sub"
LABEL org.opencontainers.image.authors=""
LABEL org.opencontainers.image.source="https://github.com/your-username/ClaudeAgentMCPServer"
LABEL org.opencontainers.image.licenses="MIT"

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy agent prompts (useful for reference)
COPY agent-prompts/ ./agent-prompts/

# Environment variables with defaults
ENV NODE_ENV=production
ENV REDIS_HOST=redis
ENV REDIS_PORT=6379
ENV REDIS_PASSWORD=
ENV REDIS_DB=0
ENV REDIS_PREFIX=agent-team:

# The MCP server communicates via stdio, not HTTP ports
# No EXPOSE needed for the MCP server itself

# Run the MCP server
CMD ["node", "dist/index.js"]
