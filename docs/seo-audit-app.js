// SEO Audit tab. A Screaming-Frog-style technical crawl of every page on
// the site (not just GSC-underperforming ones) -- fully independent of
// app.js, shares the page's password lock and apply-live plumbing
// (apply-shared.js) with the other tabs. No period selector: this is a
// point-in-time technical snapshot, not a GSC-window comparison.
//
// Six issue types are live-Applyable: canonical + duplicate-tags via the
// existing /apply-seo-tags endpoint (SEO tags), and redirect-chain/broken-
// link/missing-h1/missing-alt via new /apply-content-change operations
// (Ricos body edits, blog posts only -- static pages have no body-write
// API). Undo comes free from each endpoint's existing snapshot/restore.
// multiple-h1 and broken-page (the page itself, not a link on it, is down)
// stay report-only: no safe automatic fix exists for either.
//
// Every crawled page is included (not just ones with issues), each carrying
// a `checks` pass/fail map -- feeds the Screaming-Frog-style status grid
// above the (unchanged) issue-only detail cards below it.
//
// Also supports importing a Screaming Frog "Internal -> HTML" CSV export
// (session-only, parsed client-side, never uploaded/persisted) as a second,
// deeper data source -- same issue shape, same Apply/Undo, resolved against
// this site's own crawled `pages` (every page the native crawl already
// matched to a Wix item, regardless of whether that page had an issue).

let saLoaded = false;
let saData = null;
const saGenerated = {}; // `${src}:${pageUrl}:${issueIdx}` -> generated result
const saCsvPages = {}; // siteSlug -> pages[] parsed from an uploaded Screaming Frog CSV (session-only, never persisted)

function saEsc(s) { return applyEsc(s); }

function saShortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/ (home)' : u.pathname;
  } catch {
    return url;
  }
}

function saGenKey(page, idx) { return `${page.__src || 'native'}:${page.url}:${idx}`; }

// Stable-ish DOM id for a page's detail card, so the status grid's fail
// cells can jump straight to it. Not cryptographic -- just needs to not
// collide within one site's page list.
function saCardId(page) {
  return `${page.__src || 'native'}-${btoa(unescape(encodeURIComponent(page.url))).replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
}

function saCopyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

async function saGenerateDuplicateTags(siteSlug, page, issue, idx, btn, rerender) {
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    const result = await applyGenerateSuggestion('duplicate-tags', page.url, {
      pageUrl: page.url,
      currentTitle: page.currentTitle,
      currentMeta: page.currentMeta,
      titleDup: issue.titleDup,
      metaDup: issue.metaDup,
      bodyExcerpt: page.bodyExcerpt,
    }, { cacheSuffix: `dup-${idx}` });
    saGenerated[saGenKey(page, idx)] = result;
    rerender();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '✨ Generate fix';
    alert(`Failed to generate suggestion: ${err.message}`);
  }
}

async function saApplyDuplicateTags(siteSlug, page, issue, idx, btn) {
  const password = await applyGetPassword();
  if (!password) return;
  const gen = saGenerated[saGenKey(page, idx)];

  const payload = { site: siteSlug, itemType: page.itemType, itemId: page.itemId, password, pageUrl: page.url };
  if (issue.titleDup) payload.title = gen.title;
  if (issue.metaDup) payload.metaDescription = gen.metaDescription;

  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-seo-tags',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: prev => [issue.titleDup ? `Title: ${prev.title}` : null, issue.metaDup ? `Meta: ${prev.metaDescription}` : null].filter(Boolean).join(' | '),
    formatAfter: cur => [issue.titleDup ? `Title: ${cur.title}` : null, issue.metaDup ? `Meta: ${cur.metaDescription}` : null].filter(Boolean).join(' | '),
    buildUndoPayload: async applyData => {
      const undoPassword = await applyGetPassword();
      if (!undoPassword) return null;
      const undo = { site: siteSlug, itemType: page.itemType, itemId: page.itemId, password: undoPassword, pageUrl: page.url };
      if (issue.titleDup) undo.title = applyData.previous.title;
      if (issue.metaDup) undo.metaDescription = applyData.previous.metaDescription;
      return undo;
    },
  });
}

async function saApplyCanonical(siteSlug, page, issue, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const payload = { site: siteSlug, itemType: page.itemType, itemId: page.itemId, password, pageUrl: page.url, canonical: issue.suggested };
  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-seo-tags',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: prev => prev.canonical || '(none)',
    formatAfter: cur => cur.canonical,
    buildUndoPayload: async applyData => {
      const undoPassword = await applyGetPassword();
      if (!undoPassword) return null;
      return { site: siteSlug, itemType: page.itemType, itemId: page.itemId, password: undoPassword, pageUrl: page.url, canonical: applyData.previous.canonical || '' };
    },
  });
}

// ---------- Redirect-chain / broken-link fixes (blog posts only) ----------
//
// Both go through /apply-content-change (postId, not itemType/itemId --
// same shape Internal Linking's add_internal_link already uses), since
// these mutate the post's Ricos body content, not its SEO tags.

async function saApplyFixLink(siteSlug, page, issue, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const payload = { site: siteSlug, postId: page.itemId, password, operation: 'fix_link_url', linkUrl: issue.linkUrl, newUrl: issue.suggested, pageUrl: page.url };
  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-content-change',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: () => issue.linkUrl,
    formatAfter: cur => cur.linkUrl,
    buildUndoPayload: async applyData => {
      const undoPassword = await applyGetPassword();
      if (!undoPassword) return null;
      return { site: siteSlug, postId: page.itemId, password: undoPassword, operation: 'restore_content', richContent: applyData.previousRichContent, pageUrl: page.url };
    },
  });
}

async function saApplyRemoveLink(siteSlug, page, issue, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const payload = { site: siteSlug, postId: page.itemId, password, operation: 'remove_link', linkUrl: issue.linkUrl, pageUrl: page.url };
  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-content-change',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: () => `"${issue.anchorText}" linked to ${issue.linkUrl}`,
    formatAfter: () => `"${issue.anchorText}" as plain text`,
    buildUndoPayload: async applyData => {
      const undoPassword = await applyGetPassword();
      if (!undoPassword) return null;
      return { site: siteSlug, postId: page.itemId, password: undoPassword, operation: 'restore_content', richContent: applyData.previousRichContent, pageUrl: page.url };
    },
  });
}

// ---------- Missing H1 (blog posts only) ----------

async function saGenerateH1(siteSlug, page, idx, btn, rerender) {
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    const result = await applyGenerateSuggestion('h1', page.url, {
      pageUrl: page.url, currentTitle: page.currentTitle, bodyExcerpt: page.bodyExcerpt,
    }, { cacheSuffix: `h1-${idx}` });
    saGenerated[saGenKey(page, idx)] = result;
    rerender();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '✨ Generate H1';
    alert(`Failed to generate suggestion: ${err.message}`);
  }
}

async function saApplyH1(siteSlug, page, idx, btn) {
  const password = await applyGetPassword();
  if (!password) return;
  const gen = saGenerated[saGenKey(page, idx)];

  const payload = { site: siteSlug, postId: page.itemId, password, operation: 'add_h1', headingText: gen.headingText, pageUrl: page.url };
  const resultEl = btn.parentElement.querySelector('.ca-result');
  await applyRun({
    endpoint: '/apply-content-change',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: () => '(no H1)',
    formatAfter: cur => cur.addedH1,
    buildUndoPayload: async applyData => {
      const undoPassword = await applyGetPassword();
      if (!undoPassword) return null;
      return { site: siteSlug, postId: page.itemId, password: undoPassword, operation: 'restore_content', richContent: applyData.previousRichContent, pageUrl: page.url };
    },
  });
}

// ---------- Missing alt text (blog posts only) -- one Apply per image ----------

async function saApplyAltText(siteSlug, page, imageSrc, altText, btn) {
  const password = await applyGetPassword();
  if (!password) return;

  const payload = { site: siteSlug, postId: page.itemId, password, operation: 'set_image_alt', imageSrc, altText, pageUrl: page.url };
  const resultEl = btn.parentElement.querySelector('.ca-result') || btn.parentElement;
  await applyRun({
    endpoint: '/apply-content-change',
    payload, btn, resultEl, pageUrl: page.url,
    formatBefore: prev => prev.altText || '(none)',
    formatAfter: cur => cur.altText,
    buildUndoPayload: async applyData => {
      const undoPassword = await applyGetPassword();
      if (!undoPassword) return null;
      return { site: siteSlug, postId: page.itemId, password: undoPassword, operation: 'restore_content', richContent: applyData.previousRichContent, pageUrl: page.url };
    },
  });
}

const SEVERITY_LABEL = { high: '🔴 High', medium: '🟠 Medium', low: '⚪ Low' };

// Missing-alt is the one issue type with MULTIPLE independent fixes (one
// per image) -- rendered as its own list of rows, each with its own Copy/
// Apply button and its own `.ca-result` panel, instead of the single
// action-per-issue pattern every other type uses.
function saRenderAltRows(page, issue, idx, gen) {
  if (!gen) return `<button class="ca-apply-btn sa-generate-alt" data-page="${saEsc(page.url)}" data-idx="${idx}">✨ Suggest alt text</button>`;
  const bodyApplyable = page.matched && page.itemType === 'BLOG_POST';
  return (gen.altTexts || []).map((a, i) => `
    <div class="diff-preview">
      <div>${saEsc(a.src.split('/').pop())}</div>
      <div class="diff-add">"${saEsc(a.alt)}"</div>
      <div class="ca-issue-reason">${saEsc(a.reason || '')}</div>
    </div>
    ${bodyApplyable
      ? `<button class="ca-apply-btn sa-apply-alt" data-page="${saEsc(page.url)}" data-idx="${idx}" data-src="${saEsc(a.src)}" data-alt="${saEsc(a.alt)}">Apply live</button>`
      : `<button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc(`${a.src} -> ${a.alt}`)}">Copy</button>`}
    <div class="ca-result" hidden></div>
  `).join('');
}

function saRenderIssue(siteSlug, page, issue, idx) {
  const gen = saGenerated[saGenKey(page, idx)];
  const src = page.__src || 'native';
  const bodyApplyable = page.matched && page.itemType === 'BLOG_POST';

  let actionHtml;
  if (issue.type === 'duplicate-tags') {
    actionHtml = gen
      ? `<div class="diff-preview">
           ${issue.titleDup ? `<div class="diff-add">Title: ${saEsc(gen.title)}</div><div class="ca-issue-reason">${saEsc(gen.titleReason)}</div>` : ''}
           ${issue.metaDup ? `<div class="diff-add">Meta: ${saEsc(gen.metaDescription)}</div><div class="ca-issue-reason">${saEsc(gen.metaReason)}</div>` : ''}
         </div>
         ${page.matched ? `<button class="ca-apply-btn sa-apply-dup" data-src="${src}" data-page="${saEsc(page.url)}" data-idx="${idx}">Apply live</button>` : ''}`
      : `<button class="ca-apply-btn sa-generate-dup" data-src="${src}" data-page="${saEsc(page.url)}" data-idx="${idx}">✨ Generate fix</button>`;
  } else if (issue.type === 'missing-canonical' || issue.type === 'canonical-mismatch') {
    actionHtml = page.matched
      ? `<button class="ca-apply-btn sa-apply-canonical" data-src="${src}" data-page="${saEsc(page.url)}" data-idx="${idx}">Apply live (set canonical)</button>`
      : `<button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc(issue.suggested)}">Copy suggested canonical</button>`;
  } else if (issue.type === 'redirect-chain') {
    actionHtml = issue.applyable
      ? `<button class="ca-apply-btn sa-apply-fixlink" data-page="${saEsc(page.url)}" data-idx="${idx}">Apply live (fix link)</button>`
      : `<button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc(issue.suggested || issue.current)}">Copy details</button>`;
  } else if (issue.type === 'broken-link') {
    actionHtml = issue.applyable
      ? `<button class="ca-apply-btn sa-apply-removelink" data-page="${saEsc(page.url)}" data-idx="${idx}">Apply live (remove link)</button>`
      : `<button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc(issue.current)}">Copy details</button>`;
  } else if (issue.type === 'missing-h1') {
    actionHtml = gen
      ? `<div class="diff-preview"><div class="diff-add">${saEsc(gen.headingText)}</div><div class="ca-issue-reason">${saEsc(gen.reason || '')}</div></div>
         ${bodyApplyable ? `<button class="ca-apply-btn sa-apply-h1" data-page="${saEsc(page.url)}" data-idx="${idx}">Apply live</button>` : `<button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc(gen.headingText)}">Copy</button>`}`
      : `<button class="ca-apply-btn sa-generate-h1" data-page="${saEsc(page.url)}" data-idx="${idx}">✨ Generate H1</button>`;
  } else if (issue.type === 'missing-alt') {
    actionHtml = saRenderAltRows(page, issue, idx, gen);
  } else {
    actionHtml = `<button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc(issue.current)}">Copy details</button>`;
  }

  return `
    <div class="cr-suggestion-block">
      <div class="serp-preview-label">${SEVERITY_LABEL[issue.severity] || issue.severity} &middot; ${saEsc(issue.type.replace(/-/g, ' '))}</div>
      <div class="ca-issue-reason">Why: ${saEsc(issue.reason)}</div>
      <div class="diff-preview">
        <div>Current: <span>${saEsc((issue.current || '').slice(0, 300))}</span></div>
        ${issue.suggested && issue.type !== 'duplicate-tags' ? `<div class="diff-add">Suggested: ${saEsc(issue.suggested)}</div>` : ''}
      </div>
      ${actionHtml}
      ${issue.type !== 'missing-alt' ? '<div class="ca-result" hidden></div>' : ''}
    </div>
  `;
}

function saRenderPage(siteSlug, page) {
  if (!page.issues.length) return '';
  return `
    <div class="ca-page-card" id="sa-page-${saEsc(saCardId(page))}">
      <div class="ca-page-head">
        <a href="${saEsc(page.url)}" target="_blank">${saEsc(saShortPath(page.url))}</a>
        <span class="pill ranking-rise">${saEsc(page.itemType || 'unmatched')}</span>
        <span class="pill ctr-drop">${page.issues.length} issue${page.issues.length === 1 ? '' : 's'}</span>
        ${page.__src === 'csv' ? '<span class="pill">📥 Screaming Frog</span>' : ''}
      </div>
      ${page.issues.map((issue, i) => saRenderIssue(siteSlug, page, issue, i)).join('')}
    </div>
  `;
}

// Shared by both the native-crawl list and the CSV-import list -- finds the
// page object a clicked button's data-page/data-src refers to, and wires up
// its Generate/Apply/Copy buttons. Returns nothing; mutates saGenerated and
// re-renders the caller's own container.
function saWireButtons(container, siteSlug, pagePool, rerender) {
  container.querySelectorAll('.sa-generate-dup').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saGenerateDuplicateTags(siteSlug, page, page.issues[idx], idx, btn, rerender);
    });
  });
  container.querySelectorAll('.sa-apply-dup').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saApplyDuplicateTags(siteSlug, page, page.issues[idx], idx, btn);
    });
  });
  container.querySelectorAll('.sa-apply-canonical').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saApplyCanonical(siteSlug, page, page.issues[idx], btn);
    });
  });
  container.querySelectorAll('.sa-generate-alt').forEach(btn => {
    btn.addEventListener('click', async () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      const issue = page.issues[idx];
      btn.disabled = true;
      btn.textContent = 'Generating...';
      try {
        const result = await applyGenerateSuggestion('alt', page.url, {
          pageUrl: page.url, currentTitle: page.currentTitle, images: issue.images,
        }, { cacheSuffix: `alt-${idx}` });
        saGenerated[saGenKey(page, idx)] = result;
        rerender();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '✨ Suggest alt text';
        alert(`Failed to generate suggestion: ${err.message}`);
      }
    });
  });
  container.querySelectorAll('.sa-apply-fixlink').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saApplyFixLink(siteSlug, page, page.issues[idx], btn);
    });
  });
  container.querySelectorAll('.sa-apply-removelink').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saApplyRemoveLink(siteSlug, page, page.issues[idx], btn);
    });
  });
  container.querySelectorAll('.sa-generate-h1').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saGenerateH1(siteSlug, page, idx, btn, rerender);
    });
  });
  container.querySelectorAll('.sa-apply-h1').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saApplyH1(siteSlug, page, idx, btn);
    });
  });
  container.querySelectorAll('.sa-apply-alt').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = pagePool.find(p => p.url === btn.dataset.page);
      saApplyAltText(siteSlug, page, btn.dataset.src, btn.dataset.alt, btn);
    });
  });
  container.querySelectorAll('.sa-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => saCopyToClipboard(btn.dataset.copy, btn));
  });
}

const CHECK_COLUMNS = [
  ['canonical', 'Canonical'],
  ['h1', 'H1'],
  ['duplicateTags', 'Duplicate title/meta'],
  ['altText', 'Alt text'],
  ['links', 'Broken/redirect links'],
  ['orphan', 'Orphan'],
];

// Screaming-Frog-style full status grid: one row per crawled page (pass AND
// fail, unlike the detail cards below which only ever show failures), one
// column per check-group. A fail cell jumps to that page's detail card.
function saRenderGrid(pages) {
  if (!pages.length) return '';
  return `
    <div class="card" style="margin-bottom:1.5rem;overflow-x:auto">
      <h3>📋 Full status (${pages.length} page${pages.length === 1 ? '' : 's'})</h3>
      <table>
        <thead>
          <tr>
            <th style="text-align:left">URL</th>
            ${CHECK_COLUMNS.map(([, label]) => `<th>${saEsc(label)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${pages.map(p => `
            <tr>
              <td style="text-align:left"><a href="${saEsc(p.url)}" target="_blank">${saEsc(saShortPath(p.url))}</a></td>
              ${CHECK_COLUMNS.map(([key]) => {
                const c = p.checks[key];
                const pillStyle = 'display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;';
                if (c.status === 'pass') return `<td><span style="${pillStyle}color:#34d399;background:#064e3b">&check;</span></td>`;
                const failCount = p.issues.filter(i => (
                  (key === 'canonical' && (i.type === 'missing-canonical' || i.type === 'canonical-mismatch')) ||
                  (key === 'h1' && (i.type === 'missing-h1' || i.type === 'multiple-h1')) ||
                  (key === 'duplicateTags' && i.type === 'duplicate-tags') ||
                  (key === 'altText' && i.type === 'missing-alt') ||
                  (key === 'links' && (i.type === 'broken-link' || i.type === 'redirect-chain'))
                )).length;
                return key === 'orphan'
                  ? `<td><span style="${pillStyle}color:#f87171;background:#1c0505">orphan</span></td>`
                  : `<td><a href="#sa-page-${saEsc(saCardId(p))}"><span style="${pillStyle}color:#f87171;background:#1c0505">${failCount || 1} issue${failCount === 1 ? '' : 's'}</span></a></td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function saRenderOrphans(orphans) {
  if (!orphans?.length) return '';
  return `
    <div class="card" style="margin-top:1rem">
      <h3>🕳️ Orphan pages (${orphans.length})</h3>
      <p class="card-sub">In the sitemap, but never linked to from anywhere else on the site during this crawl. Fix via the Internal Linking tab.</p>
      <ul>${orphans.slice(0, 30).map(u => `<li><a href="${saEsc(u)}" target="_blank">${saEsc(saShortPath(u))}</a></li>`).join('')}</ul>
    </div>
  `;
}

function saRenderSite(siteSlug) {
  const site = saData[siteSlug];
  const container = document.getElementById('sa-page-list');
  const withIssues = site.pages.filter(p => p.issues.length);
  const grid = saRenderGrid(site.pages);
  const cards = withIssues.length
    ? withIssues.map(p => saRenderPage(siteSlug, p)).join('')
    : '<p class="empty">No technical issues found on this crawl.</p>';
  container.innerHTML = grid + cards + saRenderOrphans(site.orphans);
  saWireButtons(container, siteSlug, site.pages, () => saRenderSite(siteSlug));
  saRenderCsvResults(siteSlug); // re-render (not re-parse) so switching sites shows that site's own CSV import, if any
}

// ---------- Screaming Frog CSV import ----------
//
// Session-only: parsed entirely in the browser, kept in saCsvPages, never
// sent anywhere or persisted -- re-upload each visit. Supports the
// "Internal -> HTML" export first (the one report that has title, meta
// description, H1s, canonical, and status code all in one file). Builds
// the exact same issue shape the native crawl does (fetch/seo-audit.js),
// so saRenderIssue/saWireButtons work unmodified on either source.
//
// Apply-ability comes from matching a CSV row's URL against this site's own
// crawled `pages` (every page the native crawl already resolved to a Wix
// itemType/itemId, regardless of whether that page had an issue) -- a CSV
// row Apply-writes through the exact same /apply-seo-tags endpoint as the
// native crawl's issues, no separate write path.

function saParseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

const CSV_COLUMN_ALIASES = {
  url: ['address'],
  status: ['status code'],
  title: ['title 1'],
  metaDescription: ['meta description 1'],
  h1a: ['h1-1'],
  h1b: ['h1-2'],
  canonical: ['canonical link element 1'],
};

function saFindCol(headers, aliases) {
  const norm = headers.map(h => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = norm.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function saNormUrl(u) {
  try { return (u || '').split('#')[0].replace(/\/$/, ''); } catch { return u || ''; }
}

function saBuildCsvPages(siteSlug, rows) {
  if (!rows.length) return { pages: [], error: 'Empty CSV.' };
  const headers = rows[0];
  const cols = {};
  for (const key in CSV_COLUMN_ALIASES) cols[key] = saFindCol(headers, CSV_COLUMN_ALIASES[key]);
  if (cols.url === -1) return { pages: [], error: 'Could not find an "Address" column -- is this a Screaming Frog "Internal -> HTML" export?' };

  const byUrl = new Map(saData[siteSlug].pages.map(p => [saNormUrl(p.url), p]));

  const rowsData = rows.slice(1).map(r => ({
    url: r[cols.url] || '',
    status: cols.status !== -1 ? r[cols.status] : '',
    title: cols.title !== -1 ? r[cols.title] : '',
    metaDescription: cols.metaDescription !== -1 ? r[cols.metaDescription] : '',
    h1a: cols.h1a !== -1 ? r[cols.h1a] : '',
    h1b: cols.h1b !== -1 ? r[cols.h1b] : '',
    canonical: cols.canonical !== -1 ? r[cols.canonical] : '',
  })).filter(r => r.url);

  const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const byTitle = new Map(), byMeta = new Map();
  for (const r of rowsData) {
    const t = norm(r.title), d = norm(r.metaDescription);
    if (t) { if (!byTitle.has(t)) byTitle.set(t, []); byTitle.get(t).push(r.url); }
    if (d) { if (!byMeta.has(d)) byMeta.set(d, []); byMeta.get(d).push(r.url); }
  }

  const pages = [];
  for (const r of rowsData) {
    const issues = [];
    const wix = byUrl.get(saNormUrl(r.url));
    const matched = !!(wix && wix.matched);

    const statusNum = parseInt(r.status, 10);
    if (statusNum && statusNum !== 200) {
      issues.push({
        type: 'broken-page', severity: 'high', applyable: false, needsAi: false,
        reason: `Screaming Frog recorded HTTP ${statusNum} for this page.`,
        current: `HTTP ${statusNum}`, suggested: null,
      });
    }

    if (!r.canonical) {
      issues.push({
        type: 'missing-canonical', severity: 'medium', applyable: matched, needsAi: false,
        reason: 'No canonical tag found in the Screaming Frog crawl.',
        current: '(none)', suggested: r.url,
      });
    } else if (saNormUrl(r.canonical) !== saNormUrl(r.url)) {
      issues.push({
        type: 'canonical-mismatch', severity: 'medium', applyable: matched, needsAi: false,
        reason: `Canonical tag points to a different URL (${r.canonical}) than this page's own address.`,
        current: r.canonical, suggested: r.url,
      });
    }

    if (!r.h1a) {
      issues.push({
        type: 'missing-h1', severity: 'high', applyable: matched, needsAi: true,
        reason: 'No H1 found in the Screaming Frog crawl.',
        current: '(none)', suggested: null,
      });
    } else if (r.h1b) {
      issues.push({
        type: 'multiple-h1', severity: 'low', applyable: false, needsAi: false,
        reason: `Multiple H1s found: "${r.h1a}", "${r.h1b}" (only the first two are in this export -- there may be more).`,
        current: `${r.h1a} | ${r.h1b}`, suggested: null,
      });
    }

    const titleDupes = (byTitle.get(norm(r.title)) || []).filter(u => u !== r.url);
    const metaDupes = (byMeta.get(norm(r.metaDescription)) || []).filter(u => u !== r.url);
    const titleDup = !!(r.title && titleDupes.length);
    const metaDup = !!(r.metaDescription && metaDupes.length);
    if (titleDup || metaDup) {
      const parts = [];
      if (titleDup) parts.push(`title is identical to ${titleDupes.length} other page(s)`);
      if (metaDup) parts.push(`meta description is identical to ${metaDupes.length} other page(s)`);
      issues.push({
        type: 'duplicate-tags', severity: 'high', applyable: matched, needsAi: true,
        reason: `This page's ${parts.join(' and ')} in the Screaming Frog crawl.`,
        current: `Title: ${r.title || '(none)'}\nMeta: ${r.metaDescription || '(none)'}`,
        suggested: null, titleDup, metaDup,
      });
    }

    if (!issues.length) continue;
    pages.push({
      url: r.url,
      itemType: wix?.itemType || null,
      itemId: wix?.itemId || null,
      matched,
      currentTitle: r.title || null,
      currentMeta: r.metaDescription || null,
      bodyExcerpt: null,
      issues,
      __src: 'csv',
    });
  }
  return { pages, error: null };
}

function saRenderCsvResults(siteSlug) {
  const container = document.getElementById('sa-csv-results');
  const pages = saCsvPages[siteSlug];
  if (!pages) { container.innerHTML = ''; return; }
  if (!pages.length) {
    container.innerHTML = '<p class="empty">CSV imported -- no issues found for this site.</p>';
    return;
  }
  container.innerHTML = pages.map(p => saRenderPage(siteSlug, p)).join('');
  saWireButtons(container, siteSlug, pages, () => saRenderCsvResults(siteSlug));
}

function saInitCsvImport() {
  document.getElementById('sa-csv-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const siteSlug = document.getElementById('sa-site-select').value;
    const container = document.getElementById('sa-csv-results');
    container.innerHTML = '<p class="empty">Parsing...</p>';
    try {
      const text = await file.text();
      const rows = saParseCsv(text);
      const { pages, error } = saBuildCsvPages(siteSlug, rows);
      if (error) { container.innerHTML = `<p class="ca-result error" style="display:block">${saEsc(error)}</p>`; return; }
      saCsvPages[siteSlug] = pages;
      saRenderCsvResults(siteSlug);
    } catch (err) {
      container.innerHTML = `<p class="ca-result error" style="display:block">Failed to parse CSV: ${saEsc(err.message)}</p>`;
    }
  });
}

async function saLoadAll() {
  const meta = await fetch(`data/seo-audit-meta.json?v=${Date.now()}`).then(r => r.json());
  saData = {};
  for (const s of meta.sites) {
    saData[s.slug] = await fetch(`data/seo-audit-${s.slug}.json?v=${Date.now()}`).then(r => r.json());
  }

  const select = document.getElementById('sa-site-select');
  select.innerHTML = meta.sites.map(s => `<option value="${s.slug}">${saEsc(s.label)}</option>`).join('');
  select.addEventListener('change', () => saRenderSite(select.value));

  document.getElementById('sa-generated-note').textContent = `Data generated ${new Date(meta.generatedAt).toLocaleString()}`;
  saRenderSite(meta.sites[0].slug);
}

window.initSeoAudit = function () {
  if (saLoaded) return;
  saLoaded = true;
  saInitCsvImport();
  saLoadAll().catch(err => {
    document.getElementById('sa-page-list').innerHTML = `<p class="ca-result error" style="display:block">Failed to load: ${saEsc(err.message)}</p>`;
  });
};
