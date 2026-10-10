# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `HOST_NETWORK_FORWARD_HOST` config: containers with `network_mode: host` are forwarded to this address instead of failing with `CONTAINER_NO_IP`

### Fixed

- `VIRTUAL_HOST` values are normalized to bare hostnames (scheme, path, port and trailing dot stripped, lowercased) — `https://db.example.com` previously failed certificate creation with HTTP 400

## [1.0.0] - 2026-05-25

### Added

- Docker event stream monitoring for `start`, `destroy`, and `remove` events with automatic reconnection on stream failure
- Automatic proxy host creation and update in Nginx Proxy Manager based on the `VIRTUAL_HOST` container environment variable
- Per-container configuration via `VIRTUAL_HOST`, `VIRTUAL_PORT`, `VIRTUAL_SSL_CERT_ID`, and `FORWARD_HOST_MODE` environment variables
- Self-healing reconcile loop (default: every 5 minutes) that diffs running containers against existing proxy hosts and corrects divergence without manual intervention
- SSL certificate management: reuse existing NPM certificate by ID, wildcard matching (`*.example.com`), or automatic Let's Encrypt provisioning
- Container hostname resolution in three modes — `dns` (container name), `ip` (container IP), `auto` (DNS-first with IP fallback)
- JWT token management with automatic renewal at 80% TTL and exponential backoff on failure
- Exponential backoff retry logic for all NPM API calls (configurable via `NPM_MAX_RETRIES`)
- Health endpoint (`GET /health`) returning NPM and Docker reachability, version, and uptime — HTTP 200 (ok) or 503 (degraded)
- Startup scan of all running containers before entering the event loop
- Graceful shutdown on `SIGTERM`/`SIGINT` with in-flight operation drain
- Structured JSON logging via Pino with configurable level (`LOG_LEVEL`)
- Docker Secrets support via `NPM_CREDENTIALS_FILE` (KEY=VALUE format)
- Node.js 24 Single Executable Application (SEA) binary build — no Node.js runtime required on the target host
- PM2 deployment support for both SEA binary (`pm2.sea.config.cjs`) and standard Node.js runtime (`pm2.node.config.cjs`)
- CLI flags `--version` / `--help` for the SEA binary
- Multi-stage Dockerfile with `linux/amd64` and `linux/arm64` support
- GitHub Actions CI (lint, type-check, tests with coverage) and Docker publishing to GHCR and Docker Hub on semver tags

[Unreleased]: https://github.com/MOD4EVER/npm-auto-discovery/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/MOD4EVER/npm-auto-discovery/releases/tag/v1.0.0

