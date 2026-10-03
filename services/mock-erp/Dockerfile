# syntax=docker/dockerfile:1
# Local/CI simulator image. Build context: repository root.
#   docker build -f services/mock-erp/Dockerfile .
# Uses Node core modules only, so there is nothing to install and no secret to inject.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8081

WORKDIR /app

COPY services/mock-erp/package.json ./
COPY services/mock-erp/src ./src
COPY testcases/fixtures/offline/orders.json /testcases/fixtures/offline/orders.json

EXPOSE 8081

USER node

CMD ["node", "src/server.mjs"]
