FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
FROM deps AS build
ARG NEXT_PUBLIC_LOGO_URL
ENV NEXT_PUBLIC_LOGO_URL=$NEXT_PUBLIC_LOGO_URL
COPY . .
RUN npm run build
FROM base AS runner
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Keep Prisma CLI, tsx and seed/retention dependencies available to Railway's pre-deploy/setup commands and cron jobs.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/src/lib/crypto.ts /app/src/lib/time.ts /app/src/lib/errors.ts /app/src/lib/db.ts /app/src/lib/retention.ts ./src/lib/
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "server.js"]
