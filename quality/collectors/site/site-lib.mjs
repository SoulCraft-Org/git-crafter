// Shared reads for the design and usability collectors: a source scan, the
// PageSpeed Insights API with a lab fallback, a same-site crawl and Playwright
// passes over the key pages and the form pages. Every network read is cached
// per site object as a promise, so when both collectors run in one process
// each page is fetched, crawled and audited once between them, and browser
// passes run one at a time. Tests pass their own site object (fake fetch,
// recorded audit) and so never share a cache with production or each other.
//
// The site is the repo's production origin (params.origin) or, for a repo
// with no production, a built static site folder (params.site_dir) served to
// the crawl and the browser from disk. A repo with neither has no site, and
// every metric that reads one is could_not_check.
//
// Nothing here throws to a collector for a missing tool, token, browser or
// network: each read resolves to data or to { error }, and the collector turns
// an error into could_not_check. Could not verify is not the same as 0.

export * from "./site-base.mjs";
export * from "./site-scan.mjs";
export * from "./site-crawl.mjs";
export * from "./site-browser.mjs";
export * from "./site-vitals.mjs";
