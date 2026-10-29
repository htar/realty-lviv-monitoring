FROM node:24-bookworm-slim AS dependencies

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY config ./config
COPY src ./src

RUN mkdir -p /app/data \
  && chown -R node:node /app

USER node

CMD ["npm", "start"]
