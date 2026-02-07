# ── Stage 1: Build the React frontend ──────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: Production image (Nginx + Node.js API) ───────────────
FROM node:20-alpine

# Install nginx and temporary build deps for native node modules
RUN apk add --no-cache nginx \
    && apk add --no-cache --virtual .build-deps python3 make g++

# ── Set up the API ─────────────────────────────────────────────────
WORKDIR /app

COPY api/package.json ./api/
RUN cd api && npm install --omit=dev \
    && apk del .build-deps

COPY api/server.js ./api/

# ── Set up Nginx for the frontend ─────────────────────────────────
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy built frontend assets from Stage 1
COPY --from=frontend-builder /build/dist /usr/share/nginx/html

# Create uploads directory
RUN mkdir -p /app/uploads

# Copy startup script
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 80

# Start-period must exceed the 120s MySQL wait in start.sh before nginx listens on 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD wget -q -O /dev/null http://localhost/health || exit 1

CMD ["/app/start.sh"]
