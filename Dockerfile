FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY data ./data

ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/storage
VOLUME /app/storage
EXPOSE 3000
RUN mkdir -p /app/storage && chown -R node:node /app
USER node
CMD ["node", "server/index.js"]