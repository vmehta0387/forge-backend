FROM node:20-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends blender && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./package.json
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY assets ./assets

ENV NODE_ENV=production
ENV PORT=10000
ENV ASSET_ROOT=/app/assets
ENV BLENDER_BIN=/usr/bin/blender
ENV EXPORT_TIMEOUT_MS=360000

EXPOSE 10000

CMD ["npm", "start"]
