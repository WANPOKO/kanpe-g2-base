#!/usr/bin/env node
// Public-marketplace scanner — DEAD END (kept as documentation).
//
// Outcome of the 2026-04-28 investigation:
//
//   1. https://hub.evenrealities.com/store returns Nuxt SPA's 404 page
//      ("404 - Page not found: /store"). The route doesn't exist.
//
//   2. The only routes that DO exist on hub.evenrealities.com are:
//        /          — landing page (no nav links to a store)
//        /docs      — developer docs
//        /hub       — developer portal (authenticated; manages YOUR
//                      published apps)
//
//   3. The consumer-facing marketplace where end users browse apps
//      lives ENTIRELY INSIDE THE EVEN HUB MOBILE APP. There is no
//      public web URL.
//
//   4. The dev portal's /api/v1/apps/list endpoint exists and returns
//      JSON, but it is scoped to the authenticated developer's OWN
//      apps. There is no /api/v1/apps/public, /store/list, or any
//      similar variant for browsing the broader marketplace.
//
// Realistic paths to track competitor apps + ecosystem gaps:
//
//   (a) PHONE SCREENSHOTS, manually fed in. User scrolls through the
//       Even Hub app on phone, screenshots each category, drops the
//       images in a folder. A human or LLM extracts {name, developer,
//       downloads, likes, version} from each screenshot. The output
//       lands in ECOSYSTEM_GAPS.md as a date-stamped scan.
//
//   (b) MITMPROXY ON THE PHONE. Stand up mitmproxy on the LAN, install
//       its CA cert on the phone, route Even Hub app traffic through
//       it. Capture the API call(s) the consumer app makes when listing
//       the marketplace. From there, replay programmatically.
//       Cost: ~1-2h cert install + traffic capture; risk that the API
//       requires app-store-grade signing or device attestation.
//
//   (c) ASK EVEN REALITIES for an undocumented public API or a
//       partner-developer endpoint. They have a Discord; ping the team.
//
// Until one of those lands, run scan-portfolio.mjs to track YOUR OWN
// shipped apps' download/like trends. It uses the dev portal API and
// works as long as ~/.hub-portal-session.json holds a valid session.

console.log('Public marketplace is in-app only — no public web URL exists.')
console.log('See script header for details + alternatives.')
console.log('')
console.log('For tracking your own published apps:')
console.log('  node scripts/scan-portfolio.mjs')
process.exit(0)
