# Stage 1: Build UI
FROM node:22-alpine AS ui-builder
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm ci
COPY ui/ .
# Build outputs to /build/api/static via vite config
RUN mkdir -p /build/api/static && npm run build

# Stage 2: Build API
FROM golang:1.26-alpine AS api-builder
WORKDIR /build
COPY api/go.mod api/go.sum ./
RUN go mod download
COPY api/ .
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-X main.version=${VERSION}" -o /roundtable-ui .

# Stage 3: Final image
FROM alpine:3.21
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=api-builder /roundtable-ui .
COPY --from=ui-builder /build/api/static ./static/
EXPOSE 8080
ENTRYPOINT ["/app/roundtable-ui"]
