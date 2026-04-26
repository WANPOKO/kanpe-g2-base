#!/usr/bin/env node
// Playwright-driven .ehpk upload to https://hub.evenrealities.com/application.
//
// Why this exists: the Even Hub developer portal has no public upload API
// (the evenhub CLI only exposes init/login/qr/pack/self-check; the portal's
// SPA POSTs to an undocumented endpoint). This script automates the
// click-through flow so `npm run deploy:upload` can do it from CI or
// scripts after build → pack.
//
// Generic by design: reads `package_id` from `./app.json` and the .ehpk
// path from the first .ehpk in repo root (or --file). Same script works
// for Cue, Pulse, Glance, lyrics-glow without per-app forks.
//
// ─── Two modes ─────────────────────────────────────────────────────────
//
// Default — Fresh Playwright Chromium with cached session
// ────────────────────────────────────────────────────────
//   First-time:  npm install --save-dev playwright
//                npx playwright install chromium                  # ~150 MB
//                node scripts/deploy-portal.mjs                   # log in, save session
//   Subsequent:  node scripts/deploy-portal.mjs                   # auto-uses session
//                node scripts/deploy-portal.mjs --headless        # CI
//
// --attach — Connect to your existing Chrome via CDP
// ───────────────────────────────────────────────────
//   Relaunch Chrome with debug port:
//     open -a "Google Chrome" --args --remote-debugging-port=9222
//   Then in Chrome, navigate to the portal page and log in (or already-logged-in).
//   Then run:
//     node scripts/deploy-portal.mjs --attach
//   The script picks the existing tab matching the portal URL, drives the
//   upload flow, leaves your tabs intact when done.
//
// ─── Iterating on selectors ───────────────────────────────────────────
//
// On any failure the script dumps the current page HTML to
// `.deploy-portal-failure.html` so you can grep for the right selector
// and update the SELECTOR comments inline. The portal is an SPA whose DOM
// changes occasionally; expect to re-audit every few months.

import { chromium } from 'playwright'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PORTAL_BASE = 'https://hub.evenrealities.com'
const STORAGE_STATE = '.even-portal-session.json'
const APP_JSON = 'app.json'
const CDP_ENDPOINT = 'http://localhost:9222'
const FAILURE_DUMP = '.deploy-portal-failure.html'

if (!existsSync(APP_JSON)) {
  console.error(`✗ ${APP_JSON} not found — run from your app's repo root.`)
  process.exit(1)
}
const appJson = JSON.parse(readFileSync(APP_JSON, 'utf-8'))
const packageId = appJson.package_id
const appVersion = appJson.version
if (!packageId) {
  console.error(`✗ ${APP_JSON} has no package_id field.`)
  process.exit(1)
}

const args = process.argv.slice(2)
const attach = args.includes('--attach')
const headless = args.includes('--headless')
const verbose = args.includes('--verbose') || args.includes('-v')
const ehpkArg = args.find(a => a.endsWith('.ehpk'))
const ehpkPath = ehpkArg
  ? resolve(ehpkArg)
  : resolve(readdirSync('.').find(f => f.endsWith('.ehpk')) ?? 'unknown.ehpk')

if (!existsSync(ehpkPath)) {
  console.error(`✗ .ehpk not found: ${ehpkPath}`)
  console.error('  Run `npm run deploy` first, or pass an explicit path.')
  process.exit(1)
}

// Best-effort dump on any failure so we can update selectors. Always called
// before throwing so the next run has fresh DOM to inspect.
async function dumpFailure(page, where, err) {
  try {
    const html = await page.content()
    writeFileSync(FAILURE_DUMP, `<!-- failed at: ${where} -->\n<!-- error: ${err?.message ?? err} -->\n${html}`)
    console.error(`  page HTML dumped to ${FAILURE_DUMP} (${(html.length / 1024).toFixed(0)} KB)`)
    console.error('  inspect this file, find the right selector, update the matching SELECTOR comment in scripts/deploy-portal.mjs')
  } catch (dumpErr) {
    console.error(`  (also failed to dump page: ${dumpErr?.message ?? dumpErr})`)
  }
}

async function main() {
  console.log(`→ App      ${packageId} v${appVersion}`)
  console.log(`  File     ${ehpkPath}`)
  console.log(`  Mode     ${attach ? 'attach (CDP)' : headless ? 'fresh-headless' : 'fresh-headed'}`)

  let browser
  let context
  let page
  let ownsBrowser = true

  if (attach) {
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT)
    } catch (err) {
      console.error(`✗ Could not connect to Chrome at ${CDP_ENDPOINT}: ${err.message}`)
      console.error('  Quit Chrome and relaunch with:')
      console.error('    open -a "Google Chrome" --args --remote-debugging-port=9222')
      console.error('  then re-run this script.')
      process.exit(2)
    }
    ownsBrowser = false
    // Reuse the first existing context (which has the user's cookies + tabs).
    context = browser.contexts()[0] ?? (await browser.newContext())
    // Find an existing tab on the portal first; otherwise open a new one.
    const portalUrl = `${PORTAL_BASE}/application/${packageId}`
    page = context.pages().find(p => p.url().includes('hub.evenrealities.com'))
    if (page) {
      console.log(`  Found existing tab: ${page.url()}`)
      if (!page.url().includes(packageId)) {
        await page.goto(portalUrl, { waitUntil: 'networkidle' })
      }
    } else {
      console.log('  No existing portal tab — opening one.')
      page = await context.newPage()
      await page.goto(portalUrl, { waitUntil: 'networkidle' })
    }
  } else {
    browser = await chromium.launch({ headless })
    context = existsSync(STORAGE_STATE)
      ? await browser.newContext({ storageState: STORAGE_STATE })
      : await browser.newContext()
    page = await context.newPage()
    await page.goto(`${PORTAL_BASE}/application/${packageId}`, { waitUntil: 'networkidle' }).catch(() => {})

    if (!page.url().includes(`/application/${packageId}`)) {
      if (headless) {
        console.error('✗ --headless cannot be used for first login. Re-run without --headless.')
        process.exit(2)
      }
      console.log('  No saved session — log into the portal manually in the open window.')
      console.log('  Once you reach the application page, return here and press Enter.')
      await waitForEnter()
      await context.storageState({ path: STORAGE_STATE })
      console.log(`  Session saved to ${STORAGE_STATE}`)
      if (!page.url().includes(`/application/${packageId}`)) {
        await page.goto(`${PORTAL_BASE}/application/${packageId}`, { waitUntil: 'networkidle' })
      }
    }
  }

  if (verbose) {
    page.on('console', msg => console.log(`  [page:${msg.type()}] ${msg.text()}`))
    page.on('pageerror', err => console.log(`  [page:error] ${err.message}`))
  }

  // ─── Step 3: open the upload UI ───────────────────────────────────────
  // SELECTOR: upload-trigger button on the application page. Real selector
  // TBD — multiple text variants below. After first run, narrow to the one
  // that actually matches and drop the rest.
  try {
    const uploadBtn = page
      .locator(
        [
          'button:has-text("Upload new version")',
          'button:has-text("New version")',
          'button:has-text("Upload")',
          '[data-test="upload-button"]',
          '[data-testid="upload-button"]',
          'a:has-text("Upload")',
        ].join(', '),
      )
      .first()
    await uploadBtn.waitFor({ state: 'visible', timeout: 15_000 })
    await uploadBtn.click()
  } catch (err) {
    console.error('✗ Could not find upload-trigger button.')
    await dumpFailure(page, 'upload-trigger', err)
    if (ownsBrowser) await browser.close()
    process.exit(3)
  }

  // ─── Step 4: pick the file ────────────────────────────────────────────
  // SELECTOR: hidden <input type=file>. Most SPA implementations have one.
  try {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.waitFor({ state: 'attached', timeout: 8_000 })
    await fileInput.setInputFiles(ehpkPath)
    console.log('  File selected.')
  } catch (err) {
    console.error('✗ Could not find file input.')
    await dumpFailure(page, 'file-input', err)
    if (ownsBrowser) await browser.close()
    process.exit(4)
  }

  // ─── Step 5: confirm/submit ──────────────────────────────────────────
  // SELECTOR: confirm/submit button after file pick. Some portals
  // auto-upload on file pick — if so, this no-ops.
  const submitBtn = page
    .locator(
      [
        'button:has-text("Submit")',
        'button:has-text("Confirm")',
        'button:has-text("Upload")',
        'button:has-text("Save")',
        'button[type="submit"]',
      ].join(', '),
    )
    .last()
  if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await submitBtn.click()
    console.log('  Submit clicked.')
  } else {
    console.log('  No explicit submit found — assuming auto-upload on file pick.')
  }

  // ─── Step 6: accept the build (post-upload confirmation) ─────────────
  // The portal often shows a "your build is ready, accept it?" or
  // "Activate" / "Publish" step after the file is processed.
  // SELECTOR: accept/publish/activate button. May appear after a 5-30s
  // server-side processing delay.
  try {
    const acceptBtn = page.locator(
      [
        'button:has-text("Accept")',
        'button:has-text("Activate")',
        'button:has-text("Publish")',
        'button:has-text("Approve")',
        'button:has-text("Confirm build")',
      ].join(', '),
    )
    // Wait up to 60s for the build to be processable. The portal often
    // shows a "processing" spinner first.
    if (await acceptBtn.first().isVisible({ timeout: 60_000 }).catch(() => false)) {
      await acceptBtn.first().click()
      console.log('  Build accepted.')
    } else {
      console.log('  No accept-build button surfaced within 60s — may not be required for this app slot.')
    }
  } catch (err) {
    console.warn(`  Accept-build step skipped: ${err.message}`)
  }

  // ─── Step 7: success signal ──────────────────────────────────────────
  // SELECTOR: success toast / version-list update.
  await page
    .waitForSelector('text=/uploaded|success|version|active/i', { timeout: 30_000 })
    .catch(() => {
      console.warn('  No success signal seen within 30s — upload may still have worked. Check the portal.')
    })

  console.log(`✓ Upload submitted for ${packageId} v${appVersion}. Verify in the portal.`)

  // Persist session in fresh-launch mode. Attach mode uses the user's
  // own Chrome — nothing to save.
  if (!attach) {
    await context.storageState({ path: STORAGE_STATE })
  }

  // Don't close the user's Chrome in attach mode; only close ours.
  if (ownsBrowser) await browser.close()
}

function waitForEnter() {
  return new Promise(resolveFn => {
    process.stdin.once('data', () => resolveFn())
    process.stdout.write('  Press Enter when ready... ')
  })
}

main().catch(err => {
  console.error('✗ Deploy failed:', err.message)
  process.exit(1)
})
