FROM node:20-alpine
WORKDIR /app
COPY src ./src
ENV PORT=8081
EXPOSE 8081
USER node
CMD ["node", "src/server.mjs"]
