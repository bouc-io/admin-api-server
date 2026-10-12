# ---- Base ----
FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./

# ---- Dependencies ----
FROM base AS dependencies
RUN npm install

# ---- Build ----
# `npm run build` runs `prisma generate` first; the generated client is compiled into dist/.
FROM dependencies AS build
COPY . .
RUN npm run build

# ---- Production ----
# No source tree and no generate step here: the runtime uses dist/ only. prisma/ and
# prisma.config.ts are shipped for `prisma migrate deploy` at container start.
FROM base AS production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY prisma ./prisma
COPY prisma.config.ts ./

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3002

ENV NODE_ENV="development"
ENV DATABASE_URL=$DATABASE_URL
ENV PORT=3002
ENV ALLOW_SELF_SIGNED_CERTS="true"

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3002/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["sh", "-c", "npm run db:deploy && npm start"]
