# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.16.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json prisma.config.ts prisma/schema.prisma ./
RUN npm install --global npm@11.13.0 \
  && npm --version | grep -Fx 11.13.0 \
  && npm ci \
  && npm cache clean --force

FROM dependencies AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm run prisma:generate \
  && npm run build

FROM base AS production-dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm install --global npm@11.13.0 \
  && npm --version | grep -Fx 11.13.0 \
  && npm ci --omit=dev --omit=optional --omit=peer --ignore-scripts \
  && npm cache clean --force \
  && test ! -d node_modules/prisma \
  && test ! -d node_modules/typescript

FROM base AS migrate
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts/explain-audit.mjs ./scripts/explain-audit.mjs
USER node
ENTRYPOINT ["node", "node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
ENV TZ=UTC
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=production-dependencies /workspace/node_modules ./node_modules
COPY --chown=node:node --from=build /workspace/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
