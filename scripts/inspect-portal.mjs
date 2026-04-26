#!/usr/bin/env node
// Diagnostic helper for scripts/upload-dev.mjs.
//
// Connects to Chrome via CDP (must be launched with --remote-debugging-port=9222),
// finds the active tab, dumps the URL + page title + every visible button's
// text + every <a> link text + the full HTML to ./inspect-portal.out so we
// can see what selectors the dev portal page actually uses.
//
// Usage:
//   1. Quit Chrome.
//   2. open -a "Google Chrome" --args --remote-debugging-port=9222
//   3. In Chrome, navigate to the dev portal page (the one with the project list).
//   4. node scripts/inspect-portal.mjs
//   5. Read ./inspect-portal.out (HTML dump) and ./inspect-portal.summary.txt.

import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const CDP_ENDPOINT = 'http://localhost:9222'

async function main() {
  let browser
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT)
  } catch (err) {
    console.error(`✗ Could not connect to Chrome at ${CDP_ENDPOINT}: ${err.message}`)
    console.error('  Quit Chrome, then:')
    console.error('    open -a "Google Chrome" --args --remote-debugging-port=9222')
    process.exit(2)
  }

  const contexts = browser.contexts()
  const ctx = contexts[0]
  if (!ctx) {
    console.error('✗ Chrome has no browsing contexts. Open at least one tab and re-run.')
    process.exit(3)
  }
  const pages = ctx.pages()
  if (pages.length === 0) {
    console.error('✗ Chrome context has no pages.')
    process.exit(4)
  }

  // Prefer a tab on hub.evenrealities.com; otherwise use the active one.
  let page = pages.find(p => p.url().includes('hub.evenrealities.com'))
  if (!page) {
    console.warn('  No tab on hub.evenrealities.com — using the first tab instead.')
    page = pages[0]
  }

  const url = page.url()
  const title = await page.title()
  console.log(`→ URL    ${url}`)
  console.log(`  Title  ${title}`)

  // Buttons + links — text + accessible name + role.
  const visibleControls = await page.evaluate(() => {
    function trim(s) { return (s ?? '').replace(/\s+/g, ' ').trim() }
    function isVisible(el) {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const out = []
    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="file"]')) {
      if (!isVisible(el)) continue
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        text: trim(el.textContent ?? ''),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        dataTest: el.getAttribute('data-test') ?? el.getAttribute('data-testid'),
        href: el.getAttribute('href'),
      })
    }
    return out
  })

  // Heading scan — h1/h2/h3 text — to identify section labels (project names, etc.).
  const headings = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) out.push({ tag: el.tagName.toLowerCase(), text })
    }
    return out
  })

  // Common list-row patterns — look for rows inside likely list containers.
  const listRows = await page.evaluate(() => {
    const containers = document.querySelectorAll('table tbody tr, ul li, [role="listitem"], [class*="row" i], [class*="card" i], [class*="project" i], [class*="application" i]')
    const out = []
    for (const el of containers) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text && text.length < 240) out.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 200) })
    }
    return out
  })

  const html = await page.content()

  const summary = [
    `URL:   ${url}`,
    `Title: ${title}`,
    '',
    '─── Headings ────────────────────────────',
    ...headings.map(h => `  <${h.tag}> ${h.text}`),
    '',
    '─── Visible buttons / links / file inputs ───',
    ...visibleControls.map(c => {
      const bits = [c.tag]
      if (c.type) bits.push(`type=${c.type}`)
      if (c.role) bits.push(`role=${c.role}`)
      if (c.dataTest) bits.push(`data-test=${c.dataTest}`)
      if (c.ariaLabel) bits.push(`aria=${JSON.stringify(c.ariaLabel)}`)
      if (c.href) bits.push(`href=${c.href}`)
      const head = `  ${bits.join(' ')}`
      const txt = c.text ? `  text=${JSON.stringify(c.text)}` : ''
      return `${head}${txt}`
    }),
    '',
    `─── List-row candidates (${listRows.length}) ───`,
    ...listRows.slice(0, 60).map(r => `  <${r.tag}> ${r.text}`),
    listRows.length > 60 ? `  …and ${listRows.length - 60} more` : '',
  ].join('\n')

  writeFileSync('inspect-portal.summary.txt', summary)
  writeFileSync('inspect-portal.out', html)

  console.log('')
  console.log(`✓ Wrote inspect-portal.summary.txt (${summary.length} chars)`)
  console.log(`✓ Wrote inspect-portal.out         (${(html.length / 1024).toFixed(0)} KB HTML)`)
  console.log('')
  console.log('Now share the contents of inspect-portal.summary.txt — that\'s enough')
  console.log('to write the right upload-dev.mjs without guessing selectors.')
}

main().catch(err => {
  console.error('✗ Inspector failed:', err.message)
  process.exit(1)
})
