# Local/demo image only: in AWS the same handlers run as Lambda functions (infra/terraform).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
ENV PORT=8090
EXPOSE 8090
CMD ["node", "src/local/server.ts"]
