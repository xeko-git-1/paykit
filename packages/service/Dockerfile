# Multi-stage build: compile TypeScript → slim Node.js 20 Alpine runtime.
# The service image runs `serve` only. Migrations are applied separately via the
# paykit CLI bin (node packages/cli/dist/bin/paykit.js migrate up).

# --- Stage 1: Build ---
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

WORKDIR /app

# Copy workspace root files for dependency resolution
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# Copy all package.json files for workspace install
COPY packages/core/package.json packages/core/package.json
COPY packages/auth-core/package.json packages/auth-core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/service/package.json packages/service/package.json
COPY packages/stripe-adapter/package.json packages/stripe-adapter/package.json
COPY packages/sepay-adapter/package.json packages/sepay-adapter/package.json
COPY packages/nowpayments-adapter/package.json packages/nowpayments-adapter/package.json
COPY packages/vnpay-adapter/package.json packages/vnpay-adapter/package.json
COPY packages/momo-adapter/package.json packages/momo-adapter/package.json
COPY packages/zalopay-adapter/package.json packages/zalopay-adapter/package.json
COPY packages/cryptomus-adapter/package.json packages/cryptomus-adapter/package.json
COPY packages/binance-adapter/package.json packages/binance-adapter/package.json
COPY packages/coinbase-commerce-adapter/package.json packages/coinbase-commerce-adapter/package.json

# Install all workspace deps (frozen lockfile for reproducibility)
RUN pnpm install --frozen-lockfile

# Copy source for build
COPY packages/core/ packages/core/
COPY packages/auth-core/ packages/auth-core/
COPY packages/server/ packages/server/
COPY packages/cli/ packages/cli/
COPY packages/service/ packages/service/
COPY packages/stripe-adapter/ packages/stripe-adapter/
COPY packages/sepay-adapter/ packages/sepay-adapter/
COPY packages/nowpayments-adapter/ packages/nowpayments-adapter/
COPY packages/vnpay-adapter/ packages/vnpay-adapter/
COPY packages/momo-adapter/ packages/momo-adapter/
COPY packages/zalopay-adapter/ packages/zalopay-adapter/
COPY packages/cryptomus-adapter/ packages/cryptomus-adapter/
COPY packages/binance-adapter/ packages/binance-adapter/
COPY packages/coinbase-commerce-adapter/ packages/coinbase-commerce-adapter/
COPY migrations/ migrations/

# Build all packages (service depends on server, core, adapters)
RUN pnpm -r build

# --- Stage 2: Production runtime ---
FROM node:20-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

WORKDIR /app

# Copy workspace root for pnpm workspace resolution
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy built packages (dist only) + package.json for each
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/core/package.json packages/core/package.json

COPY --from=builder /app/packages/auth-core/dist packages/auth-core/dist
COPY --from=builder /app/packages/auth-core/package.json packages/auth-core/package.json

COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/packages/server/package.json packages/server/package.json

COPY --from=builder /app/packages/cli/dist packages/cli/dist
COPY --from=builder /app/packages/cli/migrations packages/cli/migrations
COPY --from=builder /app/packages/cli/package.json packages/cli/package.json

COPY --from=builder /app/packages/stripe-adapter/dist packages/stripe-adapter/dist
COPY --from=builder /app/packages/stripe-adapter/package.json packages/stripe-adapter/package.json

COPY --from=builder /app/packages/sepay-adapter/dist packages/sepay-adapter/dist
COPY --from=builder /app/packages/sepay-adapter/package.json packages/sepay-adapter/package.json

COPY --from=builder /app/packages/nowpayments-adapter/dist packages/nowpayments-adapter/dist
COPY --from=builder /app/packages/nowpayments-adapter/package.json packages/nowpayments-adapter/package.json

COPY --from=builder /app/packages/vnpay-adapter/dist packages/vnpay-adapter/dist
COPY --from=builder /app/packages/vnpay-adapter/package.json packages/vnpay-adapter/package.json

COPY --from=builder /app/packages/momo-adapter/dist packages/momo-adapter/dist
COPY --from=builder /app/packages/momo-adapter/package.json packages/momo-adapter/package.json

COPY --from=builder /app/packages/zalopay-adapter/dist packages/zalopay-adapter/dist
COPY --from=builder /app/packages/zalopay-adapter/package.json packages/zalopay-adapter/package.json

COPY --from=builder /app/packages/cryptomus-adapter/dist packages/cryptomus-adapter/dist
COPY --from=builder /app/packages/cryptomus-adapter/package.json packages/cryptomus-adapter/package.json

COPY --from=builder /app/packages/binance-adapter/dist packages/binance-adapter/dist
COPY --from=builder /app/packages/binance-adapter/package.json packages/binance-adapter/package.json

COPY --from=builder /app/packages/coinbase-commerce-adapter/dist packages/coinbase-commerce-adapter/dist
COPY --from=builder /app/packages/coinbase-commerce-adapter/package.json packages/coinbase-commerce-adapter/package.json

COPY --from=builder /app/packages/service/dist packages/service/dist
COPY --from=builder /app/packages/service/package.json packages/service/package.json

# Install production deps only
RUN pnpm install --prod --frozen-lockfile

# Non-root user for security
USER node

EXPOSE 3000

# Default command: serve. Override with: docker run <image> migrate up
ENTRYPOINT ["node", "packages/service/dist/main.js"]
CMD ["serve"]
