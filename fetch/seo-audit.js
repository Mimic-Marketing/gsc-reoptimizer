// SEO Audit: a Screaming-Frog-style technical crawl of every page on the
// site (via the sitemap), not just GSC-underperforming pages -- this is a
// different kind of check than Meta Optimization/Content Reoptimization/
// Internal Linking, which all scope to `getPeriodTargets`. There's no period
// dimension here: it's a point-in-time technical snapshot, not a GSC-window
// comparison.
//
// Checks: broken internal links / redirect chains, missing or duplicate
// canonical tag, missing/multiple H1, sitewide duplicate title/meta
// description, missing image alt text, orphan pages (in the sitemap but
// never linked to anywhere in the crawl).
//
// Canonical and sitewide-duplicate-title/meta issues are live-Applyable via
// the existing /apply-seo-tags Worker endpoint (Undo comes free from that
// endpoint's existing snapshot/restore). Redirect-chain, broken-link,
// missing-H1, and missing-alt are Applyable too, but only on matched BLOG_POST
// pages (no body-write API for static pages) -- via new /apply-content-change
// operations (fix_link_url, remove_link, add_h1, set_image_alt).
//
// Every crawled page is included in the output, not just ones with issues --
// each carries a `checks` map (per check-group pass/fail) so the frontend can
// render a full Screaming-Frog-style status grid, not only a failures list.
//
// Auth: GSC via GOOGLE_APPLICATION_CREDENTIALS or GSC_SERVICE_ACCOUNT_JSON
// (unused here, kept for parity -- SEO Audit doesn't need GSC data, only
// Wix). Wix via WIX_API_KEY.
//
// Usage: node seo-audit.js

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchSitemapUrls } from './analysis.js';
import {
  listItemSeoTags, listBlogPosts, buildWixIndexes, resolvePageWixItem, checkLinkStatus,
} from './lib/audit-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'docs', 'data');

const SITES = [
  { slug: 'mimicminds', label: 'mimicminds', sitemapUrl: 'https://www.mimicminds.com/sitemap.xml', wixSiteId: '1d570b1b-ba44-4cdd-bb4b-176a7afb7d75' },
  { slug: 'mimicproductions', label: 'mimic productions', sitemapUrl: 'https://www.mimicproductions.com/sitemap.xml', wixSiteId: '20db1d0f-b8d3-49e6-8100-03577875df69' },
];

// Defensive cap -- same style as CANDIDATE_POOL_SIZE in audit-shared.js.
// Keeps a full-site crawl (page fetch + per-link status check) bounded even
// if a sitemap is unexpectedly huge.
const MAX_PAGES_PER_SITE = 150;

function normalize(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// A full-site crawl (up to 150 pages) plus a per-link status check across
// however many unique internal links that turns up is too much to run one
// request at a time -- confirmed live: sequential took long enough that a
// manual run was cancelled rather than waited out. Runs `fn` over `items`
// with at most `limit` in flight at once, same simple batching style as the
// rest of this codebase (no new dependency for something this small).
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function processSite(site) {
  console.log(`[${site.label}] pulling sitemap + Wix SEO tags + blog posts...`);
  const [sitemapUrls, staticTags, blogTags, posts] = await Promise.all([
    fetchSitemapUrls(site.sitemapUrl),
    listItemSeoTags(site.wixSiteId, 'STATIC_PAGE'),
    listItemSeoTags(site.wixSiteId, 'BLOG_POST'),
    listBlogPosts(site.wixSiteId),
  ]);
  const indexes = buildWixIndexes(staticTags, blogTags, posts);
  const urls = sitemapUrls.slice(0, MAX_PAGES_PER_SITE);
  console.log(`[${site.label}] crawling ${urls.length} page(s)...`);

  const crawled = await mapConcurrent(urls, 8, url => resolvePageWixItem(url, indexes));
  const items = urls.map((url, i) => ({ url, item: crawled[i] }));

  // Sitewide duplicate title/meta -- group by normalized value across every
  // crawled page (not just GSC-underperforming ones), since a title/meta
  // collision is a technical issue regardless of traffic.
  const byTitle = new Map();
  const byMeta = new Map();
  for (const { url, item } of items) {
    const t = normalize(item.currentTitle);
    const d = normalize(item.currentMeta);
    if (t) { if (!byTitle.has(t)) byTitle.set(t, []); byTitle.get(t).push(url); }
    if (d) { if (!byMeta.has(d)) byMeta.set(d, []); byMeta.get(d).push(url); }
  }

  // Union of every internal link found anywhere in the crawl -- feeds both
  // the broken-link check (dedup: a link repeated on many pages is only
  // status-checked once) and the orphan-page check (sitemap URL that's
  // never a link target anywhere in the crawl).
  const allLinkTargets = new Set();
  for (const { item } of items) {
    for (const link of item.liveCrawl.internalLinks) allLinkTargets.add(link.href.split('#')[0].replace(/\/$/, ''));
  }
  const uniqueLinks = [...allLinkTargets];
  console.log(`[${site.label}] checking status of ${uniqueLinks.length} unique internal link(s)...`);
  const statuses = await mapConcurrent(uniqueLinks, 8, link => checkLinkStatus(link));
  const linkStatuses = new Map(uniqueLinks.map((link, i) => [link, statuses[i]]));

  const pages = [];
  for (const { url, item } of items) {
    const issues = [];
    // Only matched BLOG_POST pages can be write-Applied (Ricos body edits) --
    // static pages have no body-write API (resolvePageWixItem always gives
    // them bodyText: null).
    const bodyApplyable = item.matched && item.itemType === 'BLOG_POST';

    // Broken links / redirect chains found ON this page.
    for (const link of item.liveCrawl.internalLinks) {
      const key = link.href.split('#')[0].replace(/\/$/, '');
      const status = linkStatuses.get(key);
      if (!status) continue;
      if (status.broken) {
        issues.push({
          type: 'broken-link', severity: 'high', applyable: bodyApplyable, needsAi: false,
          reason: status.error
            ? `Link "${link.anchorText}" -> ${link.href} failed to resolve: ${status.error}.`
            : `Link "${link.anchorText}" -> ${link.href} returns HTTP ${status.finalStatus}.`,
          current: `${link.anchorText} -> ${link.href}`,
          suggested: null,
          anchorText: link.anchorText, linkUrl: link.href,
        });
      } else if (status.chain.length > 1) {
        const finalUrl = status.chain[status.chain.length - 1]?.url || null;
        issues.push({
          type: 'redirect-chain', severity: 'medium', applyable: bodyApplyable && !!finalUrl, needsAi: false,
          reason: `Link "${link.anchorText}" goes through ${status.chain.length - 1} redirect hop(s) before landing on HTTP ${status.finalStatus} -- update it to point straight at the final URL.`,
          current: status.chain.map(h => `${h.url} (${h.status})`).join(' -> '),
          suggested: finalUrl,
          anchorText: link.anchorText, linkUrl: link.href,
        });
      }
    }

    // Canonical -- read from Wix's own SEO-tags data (item.currentCanonical),
    // not the live-crawled HTML: confirmed live that a page can have a real
    // canonical set in Wix that simply isn't present in the fetched HTML
    // (Wix resolves/injects it separately), so the live-HTML signal alone
    // produced false "missing canonical" positives.
    if (!item.currentCanonical) {
      issues.push({
        type: 'missing-canonical', severity: 'medium', applyable: true, needsAi: false,
        reason: 'No canonical tag found -- without one, search engines have to guess the preferred URL for this content, which risks duplicate-content dilution.',
        current: '(none)', suggested: url,
      });
    } else if (item.currentCanonical.split('#')[0].replace(/\/$/, '') !== url.split('#')[0].replace(/\/$/, '')) {
      issues.push({
        type: 'canonical-mismatch', severity: 'medium', applyable: true, needsAi: false,
        reason: `Canonical tag points to a different URL (${item.currentCanonical}) than this page's own address -- confirm that's intentional, otherwise it tells search engines to credit a different page.`,
        current: item.currentCanonical, suggested: url,
      });
    }

    // Heading hierarchy.
    const h1Count = item.liveCrawl.h1s.length;
    if (h1Count === 0) {
      issues.push({
        type: 'missing-h1', severity: 'high', applyable: bodyApplyable, needsAi: true,
        reason: 'No H1 found on this page -- the H1 is the strongest on-page relevance signal after the title tag.',
        current: '(none)', suggested: null,
      });
    } else if (h1Count > 1) {
      issues.push({
        type: 'multiple-h1', severity: 'low', applyable: false, needsAi: false,
        reason: `${h1Count} H1 tags found (${item.liveCrawl.h1s.map(h => `"${h}"`).join(', ')}) -- a page should have exactly one, multiple H1s dilute the signal.`,
        current: item.liveCrawl.h1s.join(' | '), suggested: null,
      });
    }

    // Sitewide duplicate title/meta -- one combined issue per page (not two
    // separate ones) so there's a single Generate/Apply for both fields;
    // the apply payload only sends whichever field(s) were actually flagged.
    const titleDupes = (byTitle.get(normalize(item.currentTitle)) || []).filter(u => u !== url);
    const metaDupes = (byMeta.get(normalize(item.currentMeta)) || []).filter(u => u !== url);
    const titleDup = !!(item.currentTitle && titleDupes.length);
    const metaDup = !!(item.currentMeta && metaDupes.length);
    if (titleDup || metaDup) {
      const parts = [];
      if (titleDup) parts.push(`title is identical to ${titleDupes.length} other page(s) (${titleDupes.slice(0, 3).join(', ')}${titleDupes.length > 3 ? ', ...' : ''})`);
      if (metaDup) parts.push(`meta description is identical to ${metaDupes.length} other page(s) (${metaDupes.slice(0, 3).join(', ')}${metaDupes.length > 3 ? ', ...' : ''})`);
      issues.push({
        type: 'duplicate-tags', severity: 'high', applyable: item.matched, needsAi: true,
        reason: `This page's ${parts.join(' and ')} -- duplicate tags make it harder for search engines to tell pages apart.`,
        current: `Title: ${item.currentTitle || '(none)'}\nMeta: ${item.currentMeta || '(none)'}`,
        suggested: null,
        titleDup, metaDup,
      });
    }

    // Missing alt text.
    const missingAlt = item.liveCrawl.images.filter(img => !img.alt);
    if (missingAlt.length) {
      issues.push({
        type: 'missing-alt', severity: 'low', applyable: bodyApplyable, needsAi: true,
        reason: `${missingAlt.length} image(s) on this page have no alt text -- affects accessibility and image search.`,
        current: missingAlt.map(img => img.src).join('\n'),
        suggested: null,
        images: missingAlt.map(img => img.src),
      });
    }

    const isOrphan = !allLinkTargets.has(url.split('#')[0].replace(/\/$/, ''));

    // Pass/fail per check-group, across every crawled page (not just ones
    // with issues) -- feeds the frontend's Screaming-Frog-style status grid.
    const hasType = t => issues.some(i => i.type === t);
    const checks = {
      canonical: { status: hasType('missing-canonical') || hasType('canonical-mismatch') ? 'fail' : 'pass' },
      h1: { status: hasType('missing-h1') || hasType('multiple-h1') ? 'fail' : 'pass' },
      duplicateTags: { status: hasType('duplicate-tags') ? 'fail' : 'pass' },
      altText: { status: hasType('missing-alt') ? 'fail' : 'pass' },
      links: { status: hasType('broken-link') || hasType('redirect-chain') ? 'fail' : 'pass' },
      orphan: { status: isOrphan ? 'fail' : 'pass' },
    };

    pages.push({
      url,
      itemType: item.itemType,
      itemId: item.itemId,
      matched: item.matched,
      currentTitle: item.currentTitle,
      currentMeta: item.currentMeta,
      bodyExcerpt: item.bodyText ? item.bodyText.slice(0, 600) : null,
      checks,
      issues,
    });
  }

  // Orphan pages: sitemap URL that never appears as an internal link target
  // anywhere in the crawl. Report-only -- the fix (add a link to it) is
  // exactly what the Internal Linking tab already does.
  const orphans = pages.filter(p => p.checks.orphan.status === 'fail').map(p => p.url);

  console.log(`[${site.label}] ${pages.length} page(s) crawled, ${pages.filter(p => p.issues.length).length} with issues, ${orphans.length} orphan page(s)`);
  return { label: site.label, slug: site.slug, generatedAt: new Date().toISOString(), pages, orphans };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const meta = { generatedAt: new Date().toISOString(), sites: [] };
  for (const site of SITES) {
    const data = await processSite(site);
    await writeFile(path.join(OUT_DIR, `seo-audit-${site.slug}.json`), JSON.stringify(data, null, 2));
    meta.sites.push({ slug: site.slug, label: site.label });
    console.log(`[${site.label}] wrote seo-audit-${site.slug}.json`);
  }
  await writeFile(path.join(OUT_DIR, 'seo-audit-meta.json'), JSON.stringify(meta, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
