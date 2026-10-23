FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY data ./data

# Формат — текстовый файл UTF-8, одно слово в строке.
#   docker build --build-arg DICT_URL=https://.../russian_nouns.txt .
ARG DICT_URL=""
RUN if [ -n "$DICT_URL" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
      curl -fsSL "$DICT_URL" -o /tmp/extra.txt && \
      cp /tmp/extra.txt data/extra.txt && node -e "require('fs')" && \
      rm -rf /var/lib/apt/lists/*; \
    fi
COPY tools ./tools
RUN if [ -f data/extra.txt ]; then node tools/build-dictionary.js data/extra.txt; fi

ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/storage
VOLUME /app/storage
EXPOSE 3000
RUN mkdir -p /app/storage && chown -R node:node /app
USER node
CMD ["node", "server/index.js"]
