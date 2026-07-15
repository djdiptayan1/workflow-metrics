# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .
RUN pnpm build && CI=true pnpm prune --prod

FROM node:24-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends libc++1 \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node --from=build /app/build ./build
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
USER node
CMD ["node", "build"]
