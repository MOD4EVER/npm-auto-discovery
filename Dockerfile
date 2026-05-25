# Stage 1: Build — compile TypeScript to CJS bundle
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json tsup.config.ts ./
RUN npm run build

# Stage 2: Runtime — minimal production image
FROM node:24-alpine AS runtime
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
USER appuser
EXPOSE 8080
CMD ["node", "dist/main.cjs"]
