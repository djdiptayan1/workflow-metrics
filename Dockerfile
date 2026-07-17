# syntax=docker/dockerfile:1

# Build stage: use Docker Hardened Images (DHI) for security and smaller size
FROM dhi.io/node:24-alpine3.23-dev AS builder
WORKDIR /app

# Enable corepack and activate specific pnpm version
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate

# Copy lockfiles and config first for cache efficiency
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# Install dependencies with cache mount for speed
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy the rest of the source
COPY . .

# Set CI=true to avoid pnpm prune TTY errors
ENV CI=true

# Build and prune dev dependencies
RUN pnpm build && pnpm prune --prod

# Production stage: minimal runtime image
FROM dhi.io/node:24-alpine3.23
WORKDIR /app

# Copy built assets and production dependencies
COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json

# Set environment variables
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000

EXPOSE 5173
USER node

# Start the app
CMD ["node", "build"]
