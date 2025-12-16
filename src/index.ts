import express, { Request, Response, NextFunction } from 'express'
import dotenv from 'dotenv'
import { scrapeIdoxGrants, scrapeIdoxGrantsWithProgress, ProgressCallback } from './scraper'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3003

// API Key from environment
const API_KEY = process.env.IDOX_SCRAPER_API_KEY || 'idox-scraper-wlpp-2025-secure-key-p4n8q1'

// Allowed origins for CORS (Vercel deployments + localhost)
const ALLOWED_ORIGINS = [
  'https://west-linton-play-park.vercel.app',
  'https://west-linton-play-park-git-main-chris-projects.vercel.app',
  /^https:\/\/west-linton-play-park.*\.vercel\.app$/,
  'http://localhost:3000',
  'http://localhost:3001',
]

// JSON body parser
app.use(express.json())

// CORS middleware for browser requests
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin

  // Check if origin is allowed
  let isAllowed = false
  if (origin) {
    for (const allowed of ALLOWED_ORIGINS) {
      if (typeof allowed === 'string' && origin === allowed) {
        isAllowed = true
        break
      }
      if (allowed instanceof RegExp && allowed.test(origin)) {
        isAllowed = true
        break
      }
    }
  }

  if (isAllowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  next()
})

// API Key authentication middleware
// Allows requests from CORS-validated origins OR with valid API key
function authenticateApiKey(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  const origin = req.headers.origin

  // Check if request is from a CORS-validated origin (browser requests)
  // This is secure because browser CORS prevents unauthorized sites from making requests
  if (origin) {
    let isValidOrigin = false
    for (const allowed of ALLOWED_ORIGINS) {
      if (typeof allowed === 'string' && origin === allowed) {
        isValidOrigin = true
        break
      }
      if (allowed instanceof RegExp && allowed.test(origin)) {
        isValidOrigin = true
        break
      }
    }

    if (isValidOrigin) {
      // Origin-validated browser request - allow without API key
      console.log(`[Auth] Allowing request from validated origin: ${origin}`)
      next()
      return
    }
  }

  // For non-browser requests (server-to-server), require API key
  if (!authHeader) {
    res.status(401).json({ error: 'Missing Authorization header (required for server requests)' })
    return
  }

  // Support both "Bearer <key>" and just "<key>"
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader

  if (token !== API_KEY) {
    res.status(403).json({ error: 'Invalid API key' })
    return
  }

  next()
}

// Health check (no auth required)
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'idox-scraper',
    version: '2.0.0', // Updated for SSE support
    timestamp: new Date().toISOString(),
    features: ['basic-scan', 'enrichment', 'sse-streaming'],
  })
})

// Original scrape endpoint (requires auth) - returns JSON after completion
// Query params:
//   enrich=true - Scrape detail pages for full grant info (slower, ~10min for 500 grants)
app.get('/api/idox/grants', authenticateApiKey, async (req: Request, res: Response) => {
  const enrich = req.query.enrich === 'true'
  console.log(`[${new Date().toISOString()}] Starting Idox scrape (enrich=${enrich})...`)

  try {
    const result = await scrapeIdoxGrants({ enrich })
    console.log(`[${new Date().toISOString()}] Scrape complete: ${result.totalFound} grants found (enriched=${result.enriched})`)
    res.json(result)
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Scrape error:`, error)
    res.status(500).json({
      error: 'Scrape failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

/**
 * SSE Streaming endpoint for browser-direct enrichment
 *
 * GET /api/idox/grants/stream?enrich=true
 *
 * Returns Server-Sent Events (SSE) stream:
 * - event: progress  -> { current, total, grantTitle, phase }
 * - event: grant     -> { ...enrichedGrant }
 * - event: complete  -> { totalFound, enriched, scrapeDurationMs }
 * - event: error     -> { error, message }
 *
 * This allows browsers to track long-running enrichment progress in real-time,
 * bypassing Vercel's 800s serverless function timeout.
 */
app.get('/api/idox/grants/stream', authenticateApiKey, async (req: Request, res: Response) => {
  const enrich = req.query.enrich === 'true'

  console.log(`[${new Date().toISOString()}] Starting SSE stream (enrich=${enrich})...`)

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // Disable nginx buffering

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'SSE connected', enrich })}\n\n`)

  // Track if client disconnected
  let clientDisconnected = false
  req.on('close', () => {
    clientDisconnected = true
    console.log(`[${new Date().toISOString()}] SSE client disconnected`)
  })

  // Progress callback that sends SSE events
  const onProgress: ProgressCallback = (event) => {
    if (clientDisconnected) return

    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    } catch (err) {
      console.error('SSE write error:', err)
    }
  }

  try {
    // Run scrape with progress streaming
    const result = await scrapeIdoxGrantsWithProgress({ enrich }, onProgress)

    if (!clientDisconnected) {
      // Send completion event
      res.write(`event: complete\ndata: ${JSON.stringify({
        totalFound: result.totalFound,
        enriched: result.enriched,
        scrapeDurationMs: result.scrapeDurationMs,
        timestamp: result.timestamp,
      })}\n\n`)

      console.log(`[${new Date().toISOString()}] SSE stream complete: ${result.totalFound} grants`)
    }
  } catch (error) {
    if (!clientDisconnected) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Scrape failed', message: errorMessage })}\n\n`)
      console.error(`[${new Date().toISOString()}] SSE stream error:`, error)
    }
  } finally {
    if (!clientDisconnected) {
      res.end()
    }
  }
})

// Start server
app.listen(PORT, () => {
  console.log(`Idox Scraper Service v2.0.0 running on port ${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/health`)
  console.log(`JSON endpoint: http://localhost:${PORT}/api/idox/grants (requires API key)`)
  console.log(`SSE endpoint:  http://localhost:${PORT}/api/idox/grants/stream (requires API key)`)
  console.log(`CORS enabled for Vercel deployments and localhost`)
})
