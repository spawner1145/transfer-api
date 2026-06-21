# Minimal image: just Node 20 + the source. No build step required.
FROM node:20-alpine

WORKDIR /app

# We don't need any runtime dependencies (server.js only uses Node built-ins
# and Web Fetch primitives that ship with Node 18+). Wrangler is optional and
# only used for Cloudflare deployment, so we skip npm install entirely.
COPY package.json ./
COPY src ./src
COPY server.js ./

ENV PORT=8787
ENV HOST=0.0.0.0
EXPOSE 8787

CMD ["node", "server.js"]
