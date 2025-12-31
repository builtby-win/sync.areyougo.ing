# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including dev for building)
RUN pnpm install --frozen-lockfile

# Copy source files
COPY . .

# Generate drizzle migrations (if any)
RUN pnpm generate || true

# Build the Astro application
RUN pnpm build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Rebuild better-sqlite3 native module for production
RUN pnpm rebuild better-sqlite3

# Copy built application from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts

# Create data directory for SQLite
RUN mkdir -p /app/data

# Set environment variables
ENV HOST=0.0.0.0
ENV PORT=4321
ENV DATABASE_PATH=/app/data/sync.db

# Expose the port
EXPOSE 4321

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4321/ || exit 1

# Run migrations and start the server with cron
CMD ["sh", "-c", "npx tsx scripts/migrate.ts && npx tsx scripts/start-with-cron.ts"]
