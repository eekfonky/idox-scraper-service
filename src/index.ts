import express, { Request, Response, NextFunction } from 'express'
import dotenv from 'dotenv'
import { scrapeIdoxGrants } from './scraper'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3003

// API Key from environment
const API_KEY = process.env.IDOX_SCRAPER_API_KEY || 'idox-scraper-wlpp-2025-secure-key-p4n8q1'

// JSON body parser
app.use(express.json())

// API Key authentication middleware
function authenticateApiKey(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  
  if (!authHeader) {
    res.status(401).json({ error: 'Missing Authorization header' })
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
    timestamp: new Date().toISOString()
  })
})

// Scrape endpoint (requires auth)
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

// Start server
app.listen(PORT, () => {
  console.log(`Idox Scraper Service running on port ${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/health`)
  console.log(`Scrape endpoint: http://localhost:${PORT}/api/idox/grants (requires API key)`)
})
