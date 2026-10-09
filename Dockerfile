# ── Stage 1: Build the React frontend ──────────────────────────────
FROM node:26-alpine AS frontend-builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:frontend
RUN node scripts/collect-frontend-notices.mts /build/frontend-dependency-notices.txt

# ── Stage 2: Compile the API ───────────────────────────────────────
# The compiler is a development dependency; the production image below installs
# only runtime dependencies and copies the compiled CommonJS tree.
FROM node:26-alpine AS api-builder
WORKDIR /build/api
COPY api/package*.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/scripts/build.cts ./scripts/build.cts
COPY api/*.ts ./
COPY api/src ./src
RUN npm run build

# ── Stage 3: Production image (Nginx + Node.js API) ───────────────
FROM node:26-alpine

# Install runtime services plus ffmpeg for recording conversion and temporary build deps for native node modules
RUN apk add --no-cache nginx wget netcat-openbsd mariadb-client ffmpeg \
    && apk add --no-cache --virtual .build-deps python3 make g++

# ── Set up the API ─────────────────────────────────────────────────
WORKDIR /app

# This label identifies UniHub's project code; bundled components retain their licenses.
LABEL org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /app/licenses/
COPY licenses/third-party /app/licenses/third-party
COPY --from=frontend-builder /build/frontend-dependency-notices.txt /app/licenses/

COPY api/package*.json ./api/
RUN cd api && npm ci --omit=dev \
    && apk del .build-deps

COPY --from=api-builder /build/api/dist/ ./api/

RUN apk info -v > /app/licenses/alpine-packages.txt \
    && ffmpeg -L > /app/licenses/ffmpeg-license.txt 2>&1

# ── Set up Nginx for the frontend ─────────────────────────────────
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy built frontend assets from Stage 1
COPY --from=frontend-builder /build/dist /usr/share/nginx/html

# The Node API runs as this unprivileged user (fixed IDs so bind mounts can be
# prepared on the host). The supervisor and Nginx master stay root; Nginx drops
# its workers to the nginx user as before.
ENV UNIHUB_API_UID=10001 UNIHUB_API_GID=10001
RUN addgroup -S -g 10001 unihub \
    && adduser -S -D -H -h /nonexistent -s /sbin/nologin -u 10001 -G unihub unihub

# A new named volume copies this ownership; start.sh hands over older volumes.
RUN mkdir -p /app/uploads && chown unihub:unihub /app/uploads

# Copy startup script
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 80

# Allow the 300s MariaDB readiness window plus API startup before reporting failures.
HEALTHCHECK --interval=30s --timeout=5s --start-period=360s --retries=3 \
  CMD wget -q -O /dev/null http://localhost/health || exit 1

CMD ["/app/start.sh"]
