# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy package files first
COPY --from=builder /app/package*.json ./

# Install only production dependencies in final image
RUN npm ci --only=production

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create upload directory (if API needs to access it)
RUN mkdir -p /app/ftp-uploads && chmod 755 /app/ftp-uploads

# Expose API port
EXPOSE 5000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Run the API server
CMD ["node", "dist/server.js"]
