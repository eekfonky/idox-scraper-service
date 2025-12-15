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
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()

    // Navigate to login page
    console.log('Navigating to Idox portal...')
    await page.goto(IDOX_URL, { waitUntil: 'networkidle', timeout: 30000 })

    // Handle cookie consent if present
    try {
      const cookieButton = page.locator('button.ccc-accept-button, #ccc-accept-settings')
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
    await page.fill('#LogOnEmail', IDOX_USERNAME)
    await page.fill('#LogOnPassword', IDOX_PASSWORD)
    await page.click('input[type="submit"][value="Log in"]')
    
    // Wait for login to complete
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 })
    console.log('Logged in successfully')

    // Navigate to search
    console.log('Navigating to funding search...')
    await page.click('a:has-text("Search for funding")')
    await page.waitForLoadState('networkidle')

    // Apply status filters
    console.log('Applying status filters...')
    for (const status of STATUS_FILTERS) {
      const checkbox = page.locator(`input[type="checkbox"][value="${status}"]`)
      if (await checkbox.isVisible()) {
        await checkbox.check()
      }
    }

    // Apply area of work filters
    console.log('Applying area of work filters...')
    for (const area of AREA_OF_WORK_FILTERS) {
      const checkbox = page.locator(`input[type="checkbox"][value="${area}"]`)
      if (await checkbox.isVisible()) {
        await checkbox.check()
      }
    }

    // Submit search
    console.log('Submitting search...')
    await page.click('input[type="submit"][value="Search"], button:has-text("Search")')
    await page.waitForLoadState('networkidle')

    // Extract grants
    console.log('Extracting grants...')
    const grants = await extractGrants(page)

    const duration = Date.now() - startTime
    console.log(`Scrape complete in ${duration}ms`)

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

async function extractGrants(page: Page): Promise<IdoxGrant[]> {
  const grants: IdoxGrant[] = []

  // Look for grant cards/rows - adjust selectors based on actual page structure
  const grantElements = await page.locator('.scheme-card, .funding-item, tr.scheme-row').all()

  for (const element of grantElements) {
    try {
      const title = await element.locator('.scheme-title, h3, .title').textContent() || ''
      const funder = await element.locator('.funder, .organisation').textContent() || ''
      const maxAmount = await element.locator('.amount, .max-amount').textContent() || ''
      const deadline = await element.locator('.deadline, .closing-date').textContent() || ''
      const status = await element.locator('.status').textContent() || ''
      const linkElement = await element.locator('a[href*="/Scheme/View/"]').first()
      const link = await linkElement.getAttribute('href') || ''
      const areaOfWork = await element.locator('.area-of-work, .category').textContent() || ''

      if (title.trim()) {
        grants.push({
          title: title.trim(),
          funder: funder.trim(),
          maxAmount: maxAmount.trim(),
          deadline: deadline.trim(),
          status: status.trim(),
          link: link.startsWith('http') ? link : `https://funding.idoxopen4community.co.uk${link}`,
          areaOfWork: areaOfWork.trim(),
        })
      }
    } catch (err) {
      console.warn('Error extracting grant:', err)
    }
  }

  return grants
}
