# Idox Scraper Service - Disaster Recovery

**Last Updated:** December 2025

This document contains all configuration needed to restore the Idox scraper service.

## Overview

| Component | Value |
|-----------|-------|
| **Service URL** | https://idox-scraper.srv925321.hstgr.cloud |
| **VPS Host** | srv925321.hstgr.cloud (Hostinger) |
| **Container Registry** | ghcr.io/eekfonky/idox-scraper-service |
| **GitHub Repo** | github.com/eekfonky/idox-scraper-service |
| **Port** | 3003 (internal), 443 (HTTPS via Traefik) |

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ West Linton     │────▶│ VPS (Traefik)    │────▶│ Idox Portal     │
│ Play Park App   │     │ idox-scraper     │     │ (Playwright)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │                       │
        │                       ▼
        │               ┌──────────────────┐
        │               │ GitHub Actions   │
        │               │ ─────────────────│
        │               │ Build → GHCR     │
        │               └──────────────────┘
        │                       │
        │                       ▼
        │               ┌──────────────────┐
        └──────────────▶│ Watchtower       │
                        │ (Auto-updates)   │
                        └──────────────────┘
```

## Credentials

### Idox Portal Login
```
Username: chris.welsh@westlintonplaypark.org
Password: E57LZep2$$RmY2DD
Portal:   https://funding.idoxopen4community.co.uk/bca
```

### API Authentication
```
API Key: idox-scraper-wlpp-2025-secure-key-p4n8q1
Header:  Authorization: Bearer <API_KEY>
```

### VPS Access
```
SSH: ssh root@srv925321.hstgr.cloud
```

## VPS Directory Structure

```
/docker/idox-scraper/
├── docker-compose.yml
└── .env
```

## Configuration Files

### docker-compose.yml

```yaml
# Idox Scraper Service for West Linton Play Park
# SECURED with API key authentication
# December 2025
#
# HTTPS via Traefik: https://idox-scraper.srv925321.hstgr.cloud
# Auto-updated by Watchtower from ghcr.io

name: idox-scraper

services:
  scraper:
    image: ghcr.io/eekfonky/idox-scraper-service:latest
    ports:
      - "127.0.0.1:3003:3003"
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.idox-scraper.rule=Host(`idox-scraper.srv925321.hstgr.cloud`)"
      - "traefik.http.routers.idox-scraper.tls=true"
      - "traefik.http.routers.idox-scraper.entrypoints=web,websecure"
      - "traefik.http.routers.idox-scraper.tls.certresolver=mytlschallenge"
      - "traefik.http.services.idox-scraper.loadbalancer.server.port=3003"
      - "com.centurylinklabs.watchtower.enable=true"
    environment:
      PORT: 3003
      IDOX_SCRAPER_API_KEY: "idox-scraper-wlpp-2025-secure-key-p4n8q1"
      IDOX_USERNAME: "${IDOX_USERNAME}"
      IDOX_PASSWORD: "${IDOX_PASSWORD}"
    networks:
      - traefik_network
    restart: unless-stopped
    mem_limit: 2G
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

networks:
  traefik_network:
    external: true
    name: root_default
```

### .env

```bash
IDOX_USERNAME=chris.welsh@westlintonplaypark.org
IDOX_PASSWORD=E57LZep2$$RmY2DD
IDOX_SCRAPER_API_KEY=idox-scraper-wlpp-2025-secure-key-p4n8q1
```

### GitHub Actions Workflow (.github/workflows/docker-build.yml)

```yaml
name: Build and Push Docker Image

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata for Docker
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest
            type=sha,prefix=

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

### Dockerfile

```dockerfile
FROM node:20-slim

# Install Playwright dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install Playwright browsers
RUN npx playwright install chromium

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3003

# Start server
CMD ["npm", "start"]
```

## API Endpoints

### GET /health
Health check endpoint (no auth required)
```bash
curl https://idox-scraper.srv925321.hstgr.cloud/health
```

### GET /api/idox/grants
Scrape all grants from Idox portal (requires auth)
```bash
curl -H "Authorization: Bearer idox-scraper-wlpp-2025-secure-key-p4n8q1" \
  https://idox-scraper.srv925321.hstgr.cloud/api/idox/grants
```

**Response:**
```json
{
  "grants": [...],
  "totalFound": 511,
  "filtersUsed": {
    "status": ["Open for Applications", "Future"],
    "areaOfWork": [...]
  },
  "timestamp": "2025-12-15T23:30:00.000Z",
  "scrapeDurationMs": 47000
}
```

## Recovery Procedures

### 1. Full Restoration (New VPS)

```bash
# 1. SSH to new VPS
ssh root@<new-vps-ip>

# 2. Create directory
mkdir -p /docker/idox-scraper
cd /docker/idox-scraper

# 3. Create docker-compose.yml (copy from above)
nano docker-compose.yml

# 4. Create .env file (copy from above)
nano .env

# 5. Ensure Traefik network exists
docker network create root_default || true

# 6. Start service
docker compose pull
docker compose up -d

# 7. Verify
curl https://idox-scraper.<domain>/health
```

### 2. Update Code (Automatic via Watchtower)

Watchtower automatically pulls new images when you push to GitHub. Manual update:

```bash
ssh root@srv925321.hstgr.cloud
cd /docker/idox-scraper
docker compose pull
docker compose up -d
```

### 3. View Logs

```bash
ssh root@srv925321.hstgr.cloud
docker logs idox-scraper-scraper-1 --tail 100 -f
```

### 4. Restart Service

```bash
ssh root@srv925321.hstgr.cloud
cd /docker/idox-scraper
docker compose restart
```

## West Linton Play Park Integration

The main app calls this service via the client at:
```
src/lib/integrations/idox-firecrawl.ts
```

Environment variables needed in West Linton Play Park:
```
IDOX_SCRAPER_URL=https://idox-scraper.srv925321.hstgr.cloud
IDOX_SCRAPER_API_KEY=idox-scraper-wlpp-2025-secure-key-p4n8q1
```

## Watchtower Configuration

Watchtower runs on the VPS and monitors containers with the label:
```
com.centurylinklabs.watchtower.enable=true
```

It automatically pulls new images from GHCR when GitHub Actions builds complete.

## Troubleshooting

### Container won't start
```bash
docker logs idox-scraper-scraper-1
# Check for missing env vars or network issues
```

### Scraper returns 0 grants
- Check Idox credentials haven't expired
- Verify login at https://funding.idoxopen4community.co.uk/bca
- Check container logs for login errors

### API returns 401
- Verify API key matches in .env and request header
- Check Authorization header format: `Bearer <key>`

### GitHub Actions build fails
- Check TypeScript compilation: `npm run build`
- Ensure Dockerfile has all Playwright dependencies
