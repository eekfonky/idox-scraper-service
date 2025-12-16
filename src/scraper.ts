import { chromium, Browser, Page } from 'playwright'

export interface IdoxGrant {
  title: string
  funder: string
  maxAmount: string
  deadline: string
  status: string
  link: string
  areaOfWork: string
  // Enriched fields (only populated when enrich=true)
  description?: string
  eligibility?: string
  howToApply?: string
  contactInfo?: string
  additionalInfo?: string
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
  enriched: boolean
}

export interface ScrapeOptions {
  enrich?: boolean
}

// Progress event types for SSE streaming
export interface ProgressEvent {
  type: 'phase' | 'progress' | 'grant' | 'page'
  data: Record<string, unknown> | IdoxGrant
}

export type ProgressCallback = (event: ProgressEvent) => void

/**
 * Sanitize text by removing HTML artifacts and normalizing whitespace
 * Pure string processing - no AI needed
 */
function sanitizeText(text: string): string {
  if (!text) return ''

  return text
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&pound;/g, '£')
    // Collapse multiple whitespace/newlines into single space
    .replace(/\s+/g, ' ')
    // Trim leading/trailing whitespace
    .trim()
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

export async function scrapeIdoxGrants(options: ScrapeOptions = {}): Promise<IdoxScrapeResult> {
  const { enrich = false } = options
  const startTime = Date.now()
  let browser: Browser | null = null

  try {
    if (!IDOX_USERNAME || !IDOX_PASSWORD) {
      throw new Error('IDOX_USERNAME and IDOX_PASSWORD environment variables required')
    }

    console.log('Launching browser...')
    console.log(`Using credentials: ${IDOX_USERNAME.substring(0, 5)}...`)
    console.log(`Enrich mode: ${enrich}`)
    
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
    let grants = await extractGrantsSimple(page)

    // Enrich grants with detail page data if requested
    if (enrich && grants.length > 0) {
      console.log(`Enriching ${grants.length} grants with detail page data...`)
      grants = await enrichGrants(page, grants)
    }

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
      enriched: enrich,
    }
  } finally {
    if (browser) {
      await browser.close()
    }
  }
}

// Extract grants from current page with full details
async function extractGrantsFromPage(page: Page): Promise<IdoxGrant[]> {
  const grantData = await page.evaluate(() => {
    const results: Array<{
      title: string
      link: string
      funder: string
      deadline: string
      status: string
      maxAmount: string
    }> = []

    // Each grant is in a listitem containing the grant card
    const items = document.querySelectorAll('main li')

    items.forEach(item => {
      // Find the title link
      const titleLink = item.querySelector('a[href*="/Scheme/View/"]')
      if (!titleLink) return

      const title = titleLink.textContent?.trim() || ''
      const href = titleLink.getAttribute('href') || ''

      // Find funder - in paragraph after the heading
      const funderEl = item.querySelector('h3 + p')
      const funder = funderEl?.textContent?.trim() || ''

      // Find status, max value, deadline from definition lists
      let status = ''
      let maxAmount = ''
      let deadline = ''

      const terms = item.querySelectorAll('dt')
      terms.forEach(term => {
        const label = term.textContent?.trim() || ''
        const value = term.nextElementSibling?.textContent?.trim() || ''

        if (label === 'Status') status = value
        else if (label === 'Maximum value') maxAmount = value
        else if (label === 'Current deadline') deadline = value
      })

      if (title && href) {
        results.push({ title, link: href, funder, deadline, status, maxAmount })
      }
    })

    return results
  })

  return grantData.map(data => ({
    title: data.title,
    funder: data.funder,
    maxAmount: data.maxAmount,
    deadline: data.deadline,
    status: data.status,
    link: data.link.startsWith('http') ? data.link : `https://funding.idoxopen4community.co.uk${data.link}`,
    areaOfWork: '',
  }))
}

// Extract grants with pagination support
async function extractGrantsSimple(page: Page): Promise<IdoxGrant[]> {
  const allGrants: IdoxGrant[] = []
  const MAX_PAGES = 60 // Safety limit (600 grants max)
  let currentPage = 1

  // First, check the page info to see total pages available
  const pageInfo = await page.evaluate(() => {
    const text = document.body.innerText
    const match = text.match(/Page (\d+) of (\d+)/)
    return match ? { current: parseInt(match[1]), total: parseInt(match[2]) } : null
  })

  if (pageInfo) {
    console.log(`Page info: Page ${pageInfo.current} of ${pageInfo.total} (${pageInfo.total * 10} estimated grants)`)
  }

  while (currentPage <= MAX_PAGES) {
    console.log(`Extracting page ${currentPage}...`)

    const pageGrants = await extractGrantsFromPage(page)
    console.log(`Found ${pageGrants.length} grants on page ${currentPage}`)

    if (pageGrants.length === 0) break

    allGrants.push(...pageGrants)

    // Check for next page - click directly on page number instead of "Next" link
    // When logged in, pagination is in ul.pagination#pagerbottom
    // Each page link uses onclick="showResults(pageNum, true, 'Y')"
    const nextPageNum = currentPage + 1

    // Look for a link with the next page number using title attribute (most reliable)
    let nextLink = page.locator(`a[title="Click to go to page ${nextPageNum} of results"]`).first()
    let hasNext = await nextLink.isVisible({ timeout: 3000 }).catch(() => false)

    // Fallback: try getByRole with exact name
    if (!hasNext) {
      console.log(`Title selector failed, trying getByRole...`)
      nextLink = page.getByRole('link', { name: String(nextPageNum), exact: true })
      hasNext = await nextLink.isVisible({ timeout: 2000 }).catch(() => false)
    }

    // Fallback 2: use evaluate to find and return element
    if (!hasNext) {
      console.log(`getByRole failed, trying evaluate...`)
      const linkExists = await page.evaluate((pageNum) => {
        const links = Array.from(document.querySelectorAll('ul.pagination a'))
        for (const link of links) {
          if (link.textContent?.trim() === String(pageNum)) {
            return true
          }
        }
        return false
      }, nextPageNum)

      if (linkExists) {
        // If link exists but locators failed, click via evaluate
        await page.evaluate((pageNum) => {
          const links = Array.from(document.querySelectorAll('ul.pagination a'))
          for (const link of links) {
            if (link.textContent?.trim() === String(pageNum)) {
              (link as HTMLElement).click()
              return
            }
          }
        }, nextPageNum)
        console.log(`Clicked page ${nextPageNum} via evaluate`)

        // Wait for content to change
        const firstGrantTitle = pageGrants[0]?.title || ''
        try {
          await page.waitForFunction(
            (oldTitle: string) => {
              const newFirstLink = document.querySelector('main li a[href*="/Scheme/View/"]')
              const newTitle = newFirstLink?.textContent?.trim() || ''
              return newTitle !== oldTitle && newTitle.length > 0
            },
            firstGrantTitle,
            { timeout: 15000 }
          )
        } catch {
          await page.waitForTimeout(2000)
        }
        await page.waitForTimeout(500)
        currentPage++
        continue
      }
    }

    // Debug: log what we found
    if (!hasNext) {
      console.log(`No link to page ${nextPageNum} found. Checking pagination HTML...`)
      const paginationHtml = await page.evaluate(() => {
        const ul = document.querySelector('ul.pagination, #pagerbottom')
        return ul ? ul.innerHTML : 'No pagination found'
      })
      console.log(`Pagination HTML (${paginationHtml.length} chars): ${paginationHtml.substring(0, 1000)}`)
      console.log('No more pages')
      break
    }

    console.log(`Found link to page ${nextPageNum}`)

    // Get current first grant title to detect page change
    const firstGrantTitle = pageGrants[0]?.title || ''
    console.log(`Clicking page ${nextPageNum} (current first grant: "${firstGrantTitle.substring(0, 30)}...")`)

    // Click next - this triggers JavaScript/AJAX
    await nextLink.click()

    // Wait for content to change (first grant title should be different)
    // The pagination uses AJAX, so we need to wait for DOM update
    try {
      await page.waitForFunction(
        (oldTitle: string) => {
          const newFirstLink = document.querySelector('main li a[href*="/Scheme/View/"]')
          const newTitle = newFirstLink?.textContent?.trim() || ''
          return newTitle !== oldTitle && newTitle.length > 0
        },
        firstGrantTitle,
        { timeout: 15000 }
      )
    } catch (err) {
      console.log(`Page change detection failed: ${err}`)
      // Try waiting a bit and check if page actually changed
      await page.waitForTimeout(2000)
    }

    // Small delay to ensure all content is loaded
    await page.waitForTimeout(500)
    currentPage++
  }

  console.log(`Total grants extracted: ${allGrants.length}`)
  return allGrants
}

// Enrich grants by scraping their detail pages
// Optional progress callback for SSE streaming
async function enrichGrants(
  page: Page,
  grants: IdoxGrant[],
  onProgress?: ProgressCallback
): Promise<IdoxGrant[]> {
  const enrichedGrants: IdoxGrant[] = []
  const totalGrants = grants.length

  for (let i = 0; i < grants.length; i++) {
    const grant = grants[i]
    const progress = `[${i + 1}/${totalGrants}]`

    // Emit progress event for SSE
    onProgress?.({
      type: 'progress',
      data: {
        phase: 'enriching',
        current: i + 1,
        total: totalGrants,
        grantTitle: grant.title.substring(0, 60),
        percentage: Math.round(((i + 1) / totalGrants) * 100),
      },
    })

    try {
      console.log(`${progress} Enriching: ${grant.title.substring(0, 50)}...`)

      // Navigate to detail page
      await page.goto(grant.link, { waitUntil: 'networkidle', timeout: 30000 })

      // Extract detailed information from the page
      const details = await page.evaluate(() => {
        const getText = (selector: string): string => {
          const el = document.querySelector(selector)
          return el?.textContent?.trim() || ''
        }

        const getTextAfterHeading = (headingText: string): string => {
          const headings = Array.from(document.querySelectorAll('h2, h3, h4, dt, strong'))
          for (const heading of headings) {
            if (heading.textContent?.toLowerCase().includes(headingText.toLowerCase())) {
              // Get next sibling or parent's next sibling content
              let next = heading.nextElementSibling
              if (next) {
                return next.textContent?.trim() || ''
              }
              // Try getting content from definition list
              if (heading.tagName === 'DT') {
                const dd = heading.nextElementSibling
                if (dd?.tagName === 'DD') {
                  return dd.textContent?.trim() || ''
                }
              }
            }
          }
          return ''
        }

        // Try to find main content sections
        const mainContent = document.querySelector('main, .content, article, #content')
        const fullText = mainContent?.textContent || document.body.textContent || ''

        // Extract specific sections
        const description = getTextAfterHeading('description') ||
                           getTextAfterHeading('about') ||
                           getTextAfterHeading('summary') ||
                           getTextAfterHeading('overview')

        const eligibility = getTextAfterHeading('eligibility') ||
                           getTextAfterHeading('who can apply') ||
                           getTextAfterHeading('eligible')

        const howToApply = getTextAfterHeading('how to apply') ||
                          getTextAfterHeading('application') ||
                          getTextAfterHeading('apply')

        const contactInfo = getTextAfterHeading('contact') ||
                           getTextAfterHeading('enquiries')

        // Get areas of work if available
        const areasOfWork: string[] = []
        const areaLabels = document.querySelectorAll('.tag, .category, [class*="area"], [class*="tag"]')
        areaLabels.forEach(el => {
          const text = el.textContent?.trim()
          if (text && text.length < 50) {
            areasOfWork.push(text)
          }
        })

        // Also look in definition lists for area of work
        const dts = document.querySelectorAll('dt')
        dts.forEach(dt => {
          if (dt.textContent?.toLowerCase().includes('area')) {
            const dd = dt.nextElementSibling
            if (dd?.tagName === 'DD') {
              const areas = dd.textContent?.split(',').map(s => s.trim()).filter(Boolean) || []
              areasOfWork.push(...areas)
            }
          }
        })

        return {
          description: description.substring(0, 2000),
          eligibility: eligibility.substring(0, 2000),
          howToApply: howToApply.substring(0, 1000),
          contactInfo: contactInfo.substring(0, 500),
          areaOfWork: [...new Set(areasOfWork)].join(', '),
          additionalInfo: fullText.substring(0, 500)
        }
      })

      // Apply sanitization to clean up HTML artifacts
      const enrichedGrant: IdoxGrant = {
        ...grant,
        description: sanitizeText(details.description) || undefined,
        eligibility: sanitizeText(details.eligibility) || undefined,
        howToApply: sanitizeText(details.howToApply) || undefined,
        contactInfo: sanitizeText(details.contactInfo) || undefined,
        areaOfWork: sanitizeText(details.areaOfWork) || grant.areaOfWork,
        additionalInfo: sanitizeText(details.additionalInfo) || undefined,
      }
      enrichedGrants.push(enrichedGrant)

      // Emit grant event for SSE streaming (allows frontend to display grants as they arrive)
      onProgress?.({
        type: 'grant',
        data: enrichedGrant,
      })

      // Small delay to be polite to the server
      await page.waitForTimeout(500)

    } catch (error) {
      console.log(`${progress} Failed to enrich ${grant.title}: ${error}`)
      // Keep the original grant without enrichment
      enrichedGrants.push(grant)
    }
  }

  console.log(`Enrichment complete: ${enrichedGrants.length} grants processed`)
  return enrichedGrants
}

/**
 * Scrape Idox grants with progress streaming support
 * Same as scrapeIdoxGrants but emits progress events for SSE
 */
export async function scrapeIdoxGrantsWithProgress(
  options: ScrapeOptions = {},
  onProgress?: ProgressCallback
): Promise<IdoxScrapeResult> {
  const { enrich = false } = options
  const startTime = Date.now()
  let browser: Browser | null = null

  try {
    if (!IDOX_USERNAME || !IDOX_PASSWORD) {
      throw new Error('IDOX_USERNAME and IDOX_PASSWORD environment variables required')
    }

    // Emit phase: launching
    onProgress?.({
      type: 'phase',
      data: { phase: 'launching', message: 'Launching browser...' },
    })

    console.log('Launching browser...')
    console.log(`Using credentials: ${IDOX_USERNAME.substring(0, 5)}...`)
    console.log(`Enrich mode: ${enrich}`)

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)

    // Emit phase: logging in
    onProgress?.({
      type: 'phase',
      data: { phase: 'login', message: 'Logging into Idox portal...' },
    })

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

    // Emit phase: searching
    onProgress?.({
      type: 'phase',
      data: { phase: 'searching', message: 'Searching for grants...' },
    })

    // Navigate to search
    console.log('Looking for Search for funding link...')
    const searchLink = page.locator('a:has-text("Search for funding")').first()

    if (await searchLink.isVisible({ timeout: 5000 })) {
      console.log('Navigating to funding search...')
      await searchLink.click()
      await page.waitForLoadState('networkidle', { timeout: 30000 })
    }

    console.log(`Now at: ${page.url()}`)

    // Apply filters
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

    // Emit phase: extracting
    onProgress?.({
      type: 'phase',
      data: { phase: 'extracting', message: 'Extracting grants from search results...' },
    })

    console.log(`Search results at: ${page.url()}`)
    console.log('Extracting grants...')
    let grants = await extractGrantsSimple(page)

    // Emit grants found
    onProgress?.({
      type: 'phase',
      data: {
        phase: 'extracted',
        message: `Found ${grants.length} grants`,
        grantsFound: grants.length,
      },
    })

    // Enrich grants with detail page data if requested
    if (enrich && grants.length > 0) {
      onProgress?.({
        type: 'phase',
        data: {
          phase: 'enriching_start',
          message: `Starting enrichment of ${grants.length} grants...`,
          totalGrants: grants.length,
        },
      })

      console.log(`Enriching ${grants.length} grants with detail page data...`)
      grants = await enrichGrants(page, grants, onProgress)
    }

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
      enriched: enrich,
    }
  } finally {
    if (browser) {
      await browser.close()
    }
  }
}
