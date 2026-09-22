# syntax=docker/dockerfile:1
# Local/CI simulator image. Build context: services/mock-erp
#   docker build -f services/mock-erp/Dockerfile services/mock-erp
# Uses Node core modules only, so there is nothing to install and no secret to inject.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8081

WORKDIR /app

COPY package.json ./
COPY src ./src

EXPOSE 8081

USER node

CMD ["node", "src/server.js"]
FROM node:20-alpine
WORKDIR /app
COPY src ./src
ENV PORT=8081
EXPOSE 8081
USER node
CMD ["node", "src/server.mjs"]
