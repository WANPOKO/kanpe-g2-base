#!/usr/bin/env node
// Scan the user's PUBLISHED apps from the Even Hub developer portal.
// Uses the authenticated /api/v1/apps/list endpoint we discovered by
// inspecting the dev portal's network traffic.
//
// What this is: portfolio tracker — downloads, likes, version history
// per app you've shipped. Useful for "is the new release getting any
// traction?" and "is this card-game pack actually used?".
//
// What this is NOT: a public marketplace scan. The consumer-facing
// marketplace lives entirely in the Even Hub mobile app (no public web
// URL exists; hub.evenrealities.com/store returns a Nuxt SPA 404).
// To track competitor apps + ecosystem gaps, the realistic paths are:
//   (a) phone screenshots fed back into ECOSYSTEM_GAPS.md
//   (b) mitmproxy on the phone to capture the consumer-app endpoints
// Both require user-side setup; neither is automated by this script.
//
// Usage:
//   node scripts/scan-portfolio.mjs                  # writes scan-portfolio.<date>.json
//   node scripts/scan-portfolio.mjs -o out.json
//   node scripts/scan-portfolio.mjs --headed         # watch the browser

import { chromium } from 'playwright-core'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STORAGE_STATE = `${process.env.HOME}/.hub-portal-session.json`
const HUB = 'https://hub.evenrealities.com'
const args = process.argv.slice(2)
const headless = !args.includes('--headed')
const outIdx = args.findIndex(a => a === '-o' || a === '--output')
const today = new Date().toISOString().slice(0, 10)
const outPath = outIdx >= 0
  ? resolve(args[outIdx + 1])
  : resolve(`scan-portfolio.${today}.json`)

if (!existsSync(STORAGE_STATE)) {
  console.error(`✗ No session at ${STORAGE_STATE}. Run scripts/inspect-hub.mjs first.`)
  process.exit(1)
}

async function main() {
  console.log(`→ Portal   ${HUB}`)
  console.log(`  Mode     ${headless ? 'headless' : 'headed'}`)
  console.log(`  Output   ${outPath}`)

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({ storageState: STORAGE_STATE })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)

  // The dev portal stores its JWT in localStorage (key: er_auth_state_store)
  // and passes it as `Authorization: Bearer <token>` on every API call.
  // Cookies alone don't authenticate. So: navigate, let the auth-refresh
  // round trip happen, then read the (possibly-rotated) access token
  // from localStorage and use it ourselves.
  await page.goto(`${HUB}/hub`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1_500)

  const accessToken = await page.evaluate(() => {
    const raw = window.localStorage.getItem('er_auth_state_store')
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return parsed.accessToken && parsed.accessToken.length > 0 ? parsed.accessToken : null
    } catch { return null }
  })
  if (!accessToken) {
    console.error('')
    console.error('✗ Session expired or invalid.')
    console.error('  Symptom: localStorage.er_auth_state_store has no accessToken after')
    console.error('  /hub navigation. The dev portal\'s /api/v1/auth/refresh endpoint')
    console.error('  rejected the saved refresh token (code 1006 "auth error"), then')
    console.error('  the page nulled out the auth state.')
    console.error('')
    console.error('  Fix: re-login by running')
    console.error('         node scripts/inspect-hub.mjs')
    console.error('  (opens a headed Chromium for manual login; saves a fresh session')
    console.error('  to ~/.hub-portal-session.json). Then re-run this script.')
    await browser.close()
    process.exit(2)
  }
  console.log(`  Auth     access token loaded (jwt, ${accessToken.length} chars)`)

  const PAGE_SIZE = 50
  const all = []
  let pg = 1
  while (true) {
    const result = await page.evaluate(async ({ page: pg, token }) => {
      const r = await fetch(`/api/v1/apps/list?page=${pg}&page_size=50`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      })
      return { status: r.status, body: await r.text() }
    }, { page: pg, token: accessToken })
    if (result.status !== 200) {
      console.error(`✗ ${result.status} on page ${pg}: ${result.body.slice(0, 200)}`)
      break
    }
    const json = JSON.parse(result.body)
    if (json.code !== 0) {
      console.error(`✗ API error code=${json.code} msg=${json.msg ?? ''}`)
      break
    }
    const list = json.data?.list ?? []
    all.push(...list)
    console.log(`  page ${pg}: ${list.length} apps (total so far: ${all.length})`)
    if (list.length < PAGE_SIZE) break
    pg++
    if (pg > 20) break
  }

  // Slim down each entry to fields useful for tracking trends.
  const summary = all.map(entry => {
    const app = entry.app ?? entry
    const versions = (app.versions ?? []).map(v => ({
      version: v.version_name ?? v.version,
      releasedAt: v.created_at,
      downloads: v.download_count ?? 0,
    }))
    return {
      packageId: app.package_id,
      name: app.name,
      tagline: app.tagline,
      description: app.description,
      iconPath: app.icon,
      latestVersion: versions[0]?.version,
      latestReleasedAt: versions[0]?.releasedAt,
      totalDownloads: app.download_count ?? versions.reduce((s, v) => s + (v.downloads ?? 0), 0),
      likes: app.like_count ?? entry.like_count ?? 0,
      status: app.status ?? entry.status,
      versions,
      // Keep raw entry for future fields we don't know about yet.
      _raw: entry,
    }
  })

  const result = {
    scannedAt: new Date().toISOString(),
    portalUrl: HUB,
    appCount: summary.length,
    apps: summary,
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\n✓ ${summary.length} apps written to ${outPath}`)

  // Friendly stdout summary.
  console.log(`\nApps:`)
  for (const a of summary) {
    const dl = a.totalDownloads.toString().padStart(5)
    const likes = (a.likes ?? 0).toString().padStart(4)
    console.log(`  ${dl} dl  ${likes} ♡  ${a.packageId.padEnd(32)} v${a.latestVersion ?? '?'}`)
  }

  await browser.close()
}

main().catch(err => {
  console.error('✗ Scan failed:', err.message)
  process.exit(1)
})
