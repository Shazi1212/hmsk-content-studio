# Content Studio: Next.js app + Prisma. Migrations and the (empty-database-only) demo seed run on every start.
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# Dev dependencies stay installed: `prisma db seed` runs through tsx at start-up.
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# The build never connects to a database; Prisma only needs a syntactically valid URL.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npm run build

FROM node:22-bookworm-slim AS run
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
