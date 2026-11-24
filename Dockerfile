FROM node:22-alpine AS builder
WORKDIR /app/dashboard

COPY dashboard/package*.json ./
RUN npm ci --legacy-peer-deps

COPY dashboard/ ./
RUN npm run build && npm run build:api

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=builder /app/dashboard/package.json ./package.json
COPY --from=builder /app/dashboard/server.mjs ./server.mjs
COPY --from=builder /app/dashboard/dist ./dist
COPY --from=builder /app/dashboard/dist-api ./dist-api
COPY --from=builder /app/dashboard/public/fairprice_data.json ./public/fairprice_data.json

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
