import { chromium, Browser, Page } from 'playwright'

export interface IdoxGrant {
  title: string
  funder: string
  maxAmount: string
  deadline: string
  status: string
  link: string
  areaOfWork: string
}

export interface IdoxScrapeResult {
  grants: IdoxGrant[]
  totalFound: number
  filtersUsed: {
    status: string[]
    areaOfWork: string[]
  }
  timestamp: string
  scrapeDurationMs: number
}

// Idox portal configuration
const IDOX_URL = 'https://funding.idoxopen4community.co.uk/bca'
const IDOX_USERNAME = process.env.IDOX_USERNAME || ''
const IDOX_PASSWORD = process.env.IDOX_PASSWORD || ''

// Area of work filters relevant to West Linton Play Park
const AREA_OF_WORK_FILTERS = [
  'Community',
  'Disability', 
  'Supporting Parents and Children',
  'Promoting Mental Health',
  'Promoting Physical Health',
  'Community Facilities',
  'Sport and Recreation',
  'Play Opportunities',
]

const STATUS_FILTERS = ['Open for Applications', 'Future']

export async function scrapeIdoxGrants(): Promise<IdoxScrapeResult> {
  const startTime = Date.now()
  let browser: Browser | null = null

  try {
    if (!IDOX_USERNAME || !IDOX_PASSWORD) {
      throw new Error('IDOX_USERNAME and IDOX_PASSWORD environment variables required')
    }

    console.log('Launching browser...')
    console.log(`Using credentials: ${IDOX_USERNAME.substring(0, 5)}...`)
    
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()
    
    // Set default timeout for all operations
    page.setDefaultTimeout(10000)

    // Navigate to login page
    console.log('Navigating to Idox portal...')
    await page.goto(IDOX_URL, { waitUntil: 'networkidle', timeout: 30000 })

    // Handle cookie consent if present
    try {
      const cookieButton = page.locator('button.ccc-accept-button, #ccc-accept-settings, [data-ccc-action="accept"]')
      if (await cookieButton.isVisible({ timeout: 3000 })) {
        console.log('Accepting cookies...')
        await cookieButton.click()
        await page.waitForTimeout(1000)
      }
    } catch {
      console.log('No cookie banner found, continuing...')
    }

    // Login
    console.log('Logging in...')
    await page.waitForSelector('#LogOnEmail', { timeout: 10000 })
    
    await page.fill('#LogOnEmail', '')
    await page.fill('#LogOnEmail', IDOX_USERNAME)
    await page.fill('#LogOnPassword', '')
    await page.fill('#LogOnPassword', IDOX_PASSWORD)
    
    console.log('Clicking login button...')
    
    await Promise.all([
      page.click('input[type="submit"][value="Log in"]'),
      Promise.race([
        page.waitForURL('**/Home**', { timeout: 30000 }).catch(() => null),
        page.waitForSelector('a:has-text("Search for funding")', { timeout: 30000 }).catch(() => null),
        page.waitForTimeout(5000),
      ])
    ])
    
    const currentUrl = page.url()
    console.log(`Current URL after login: ${currentUrl}`)
    
    const stillOnLogin = await page.locator('#LogOnEmail').isVisible().catch(() => false)
    if (stillOnLogin) {
      const errorMsg = await page.locator('.validation-summary-errors').textContent().catch(() => '')
      throw new Error(`Login failed. Error: ${errorMsg || 'Unknown'}`)
    }
    
    console.log('Logged in successfully')
    
    // Navigate to search
    console.log('Looking for Search for funding link...')
    const searchLink = page.locator('a:has-text("Search for funding")').first()
    
    if (await searchLink.isVisible({ timeout: 5000 })) {
      console.log('Navigating to funding search...')
      await searchLink.click()
      await page.waitForLoadState('networkidle', { timeout: 30000 })
    }

    console.log(`Now at: ${page.url()}`)

    // Apply filters (optional, skip if not found)
    console.log('Applying filters...')
    for (const status of STATUS_FILTERS) {
      try {
        const checkbox = page.locator(`label:has-text("${status}") input`).first()
        if (await checkbox.isVisible({ timeout: 1000 })) {
          await checkbox.check()
        }
      } catch { /* skip */ }
    }

    // Submit search
    console.log('Submitting search...')
    try {
      const searchButton = page.locator('button.siteSearchFilter').first()
      if (await searchButton.isVisible({ timeout: 2000 })) {
        await searchButton.click()
        await page.waitForLoadState('networkidle', { timeout: 30000 })
      }
    } catch { /* continue without clicking */ }

    console.log(`Search results at: ${page.url()}`)

    // Extract grants using simple approach
    console.log('Extracting grants...')
    const grants = await extractGrantsSimple(page)

    const duration = Date.now() - startTime
    console.log(`Scrape complete in ${duration}ms - found ${grants.length} grants`)

    return {
      grants,
      totalFound: grants.length,
      filtersUsed: {
        status: STATUS_FILTERS,
        areaOfWork: AREA_OF_WORK_FILTERS,
      },
      timestamp: new Date().toISOString(),
      scrapeDurationMs: duration,
    }
  } finally {
    if (browser) {
      await browser.close()
    }
  }
}

// Simplified extraction that won't hang
async function extractGrantsSimple(page: Page): Promise<IdoxGrant[]> {
  const grants: IdoxGrant[] = []

  // Use evaluate to extract directly in browser context - much faster and won't hang
  const grantData = await page.evaluate(() => {
    const results: Array<{title: string, link: string, funder: string, deadline: string}> = []
    
    // Find all scheme links
    const links = document.querySelectorAll('a[href*="/Scheme/View/"]')
    
    links.forEach(link => {
      const title = link.textContent?.trim() || ''
      const href = link.getAttribute('href') || ''
      
      // Try to find parent container for more info
      const container = link.closest('.list-group-item, .scheme-card, article, tr')
      let funder = ''
      let deadline = ''
      
      if (container) {
        // Look for funder/organisation text
        const funderEl = container.querySelector('.funder, .organisation, [class*="funder"]')
        if (funderEl) funder = funderEl.textContent?.trim() || ''
        
        // Look for deadline text
        const deadlineEl = container.querySelector('.deadline, .closing, [class*="deadline"]')
        if (deadlineEl) deadline = deadlineEl.textContent?.trim() || ''
      }
      
      if (title && href) {
        results.push({ title, link: href, funder, deadline })
      }
    })
    
    return results
  })

  console.log(`Extracted ${grantData.length} grants via page.evaluate`)

  for (const data of grantData) {
    grants.push({
      title: data.title,
      funder: data.funder,
      maxAmount: '',
      deadline: data.deadline,
      status: '',
      link: data.link.startsWith('http') ? data.link : `https://funding.idoxopen4community.co.uk${data.link}`,
      areaOfWork: '',
    })
  }

  return grants
}
