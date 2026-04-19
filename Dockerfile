FROM node:20-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    pip3 install --no-cache-dir numpy trimesh && \
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
ENV PYTHON_BIN=/usr/bin/python3
ENV TRIMESH_CLEAN_TIMEOUT_MS=120000

EXPOSE 10000

CMD ["npm", "start"]
