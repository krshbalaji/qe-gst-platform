FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# data/ holds db.json (and .env if you choose to bake one in, though a bind-mounted
# volume + real platform secrets are the better choice -- see DEPLOYMENT.md).
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
EXPOSE 4000

# Basic container healthcheck hitting the app's own /healthz route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/healthz', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
