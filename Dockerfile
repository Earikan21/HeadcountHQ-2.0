# Zero-dependency app: no `npm install`, no build step, no native compilation.
# The host just runs Node against the source.
FROM node:22-slim

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/headcount.sqlite
ENV PORT=3000

EXPOSE 3000
VOLUME ["/data"]

# --experimental-sqlite enables Node's built-in SQLite (node:sqlite).
CMD ["node", "--experimental-sqlite", "src/server.js"]
