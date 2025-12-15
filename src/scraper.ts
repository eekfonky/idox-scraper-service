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
  debug?: string
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
    
    // Clear and fill fields
    await page.fill('#LogOnEmail', '')
    await page.fill('#LogOnEmail', IDOX_USERNAME)
    await page.fill('#LogOnPassword', '')
    await page.fill('#LogOnPassword', IDOX_PASSWORD)
    
    console.log('Clicking login button...')
    
    // Click login and wait for either navigation OR page content change
    await Promise.all([
      page.click('input[type="submit"][value="Log in"]'),
      // Wait for either: navigation, URL change, or login form to disappear
      Promise.race([
        page.waitForURL('**/Home**', { timeout: 30000 }).catch(() => null),
        page.waitForURL('**/Dashboard**', { timeout: 30000 }).catch(() => null),
        page.waitForSelector('a:has-text("Search for funding")', { timeout: 30000 }).catch(() => null),
        page.waitForSelector('.dashboard', { timeout: 30000 }).catch(() => null),
        page.waitForTimeout(5000), // Fallback: just wait
      ])
    ])
    
    // Check current URL and page state
    const currentUrl = page.url()
    console.log(`Current URL after login: ${currentUrl}`)
    
    // Check if still on login page (login failed)
    const stillOnLogin = await page.locator('#LogOnEmail').isVisible().catch(() => false)
    if (stillOnLogin) {
      // Check for error message
      const errorMsg = await page.locator('.validation-summary-errors, .error-message, .alert-danger').textContent().catch(() => '')
      throw new Error(`Login failed. Still on login page. Error: ${errorMsg || 'Unknown'}`)
    }
    
    console.log('Logged in successfully')
    
    // Look for "Search for funding" link
    console.log('Looking for Search for funding link...')
    const searchLink = page.locator('a:has-text("Search for funding"), a:has-text("Search Funding"), a[href*="Search"]')
    
    if (await searchLink.isVisible({ timeout: 5000 })) {
      console.log('Navigating to funding search...')
      await searchLink.click()
      await page.waitForLoadState('networkidle', { timeout: 30000 })
    } else {
      // Try direct navigation to search page
      console.log('Search link not found, trying direct navigation...')
      await page.goto('https://funding.idoxopen4community.co.uk/bca/Search', { 
        waitUntil: 'networkidle', 
        timeout: 30000 
      })
    }

    console.log(`Now at: ${page.url()}`)

    // Apply status filters
    console.log('Applying status filters...')
    for (const status of STATUS_FILTERS) {
      try {
        const checkbox = page.locator(`input[type="checkbox"][value="${status}"], label:has-text("${status}") input`)
        if (await checkbox.isVisible({ timeout: 2000 })) {
          await checkbox.check()
          console.log(`  Checked: ${status}`)
        }
      } catch {
        console.log(`  Skipped: ${status} (not found)`)
      }
    }

    // Apply area of work filters
    console.log('Applying area of work filters...')
    for (const area of AREA_OF_WORK_FILTERS) {
      try {
        const checkbox = page.locator(`input[type="checkbox"][value="${area}"], label:has-text("${area}") input`)
        if (await checkbox.isVisible({ timeout: 1000 })) {
          await checkbox.check()
          console.log(`  Checked: ${area}`)
        }
      } catch {
        // Skip silently
      }
    }

    // Submit search
    console.log('Submitting search...')
    const searchButton = page.locator('input[type="submit"][value="Search"], button:has-text("Search"), input[value="Search"]')
    if (await searchButton.isVisible({ timeout: 3000 })) {
      await searchButton.click()
      await page.waitForLoadState('networkidle', { timeout: 30000 })
    }

    console.log(`Search results at: ${page.url()}`)

    // Extract grants
    console.log('Extracting grants...')
    const grants = await extractGrants(page)

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

async function extractGrants(page: Page): Promise<IdoxGrant[]> {
  const grants: IdoxGrant[] = []

  // Try multiple selector patterns for grant listings
  const selectors = [
    '.scheme-card',
    '.funding-item', 
    'tr.scheme-row',
    '.search-result',
    '.grant-item',
    'article.scheme',
    '[data-scheme-id]',
    '.list-group-item:has(a[href*="/Scheme/"])',
  ]

  let grantElements: any[] = []
  
  for (const selector of selectors) {
    const elements = await page.locator(selector).all()
    if (elements.length > 0) {
      console.log(`Found ${elements.length} grants with selector: ${selector}`)
      grantElements = elements
      break
    }
  }

  // If no specific selectors work, try finding any links to scheme pages
  if (grantElements.length === 0) {
    console.log('No grant elements found with standard selectors, looking for scheme links...')
    const schemeLinks = await page.locator('a[href*="/Scheme/View/"]').all()
    console.log(`Found ${schemeLinks.length} scheme links`)
    
    for (const link of schemeLinks) {
      try {
        const title = await link.textContent() || ''
        const href = await link.getAttribute('href') || ''
        
        if (title.trim() && href) {
          grants.push({
            title: title.trim(),
            funder: '',
            maxAmount: '',
            deadline: '',
            status: '',
            link: href.startsWith('http') ? href : `https://funding.idoxopen4community.co.uk${href}`,
            areaOfWork: '',
          })
        }
      } catch (err) {
        console.warn('Error extracting scheme link:', err)
      }
    }
    
    return grants
  }

  for (const element of grantElements) {
    try {
      const title = await element.locator('.scheme-title, h3, .title, a').first().textContent() || ''
      const funder = await element.locator('.funder, .organisation, .provider').textContent().catch(() => '')
      const maxAmount = await element.locator('.amount, .max-amount, .funding-amount').textContent().catch(() => '')
      const deadline = await element.locator('.deadline, .closing-date, .end-date').textContent().catch(() => '')
      const status = await element.locator('.status, .scheme-status').textContent().catch(() => '')
      const linkElement = element.locator('a[href*="/Scheme/"]').first()
      const link = await linkElement.getAttribute('href').catch(() => '') || ''
      const areaOfWork = await element.locator('.area-of-work, .category, .tags').textContent().catch(() => '')

      if (title.trim()) {
        grants.push({
          title: title.trim(),
          funder: funder?.trim() || '',
          maxAmount: maxAmount?.trim() || '',
          deadline: deadline?.trim() || '',
          status: status?.trim() || '',
          link: link.startsWith('http') ? link : `https://funding.idoxopen4community.co.uk${link}`,
          areaOfWork: areaOfWork?.trim() || '',
        })
      }
    } catch (err) {
      console.warn('Error extracting grant:', err)
    }
  }

  return grants
}
