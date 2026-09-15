// SEO Audit tab. A Screaming-Frog-style technical crawl of every page on
// the site (not just GSC-underperforming ones) -- fully independent of
// app.js, shares the page's password lock and apply-live plumbing
// (apply-shared.js) with the other tabs. No period selector: this is a
// point-in-time technical snapshot, not a GSC-window comparison.
//
// Two issue types are live-Applyable (canonical, duplicate-tags), both via
// the existing /apply-seo-tags endpoint -- Undo comes free from that
// endpoint's existing snapshot/restore, same as Meta Optimization. Every
// other issue type (broken-link, broken-page, redirect-chain, missing-h1,
// multiple-h1, missing-alt) is report-only: Copy button, no Apply.
//
// Also supports importing a Screaming Frog "Internal -> HTML" CSV export
// (session-only, parsed client-side, never uploaded/persisted) as a second,
// deeper data source -- same issue shape, same Apply/Undo, resolved against
// this site's `urlIndex` (every page the native crawl already matched to a
// Wix item, regardless of whether that page had an issue).

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

const SEVERITY_LABEL = { high: '🔴 High', medium: '🟠 Medium', low: '⚪ Low' };

function saRenderIssue(siteSlug, page, issue, idx) {
  const gen = saGenerated[saGenKey(page, idx)];
  const src = page.__src || 'native';

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
  } else if (issue.type === 'missing-alt') {
    actionHtml = `<button class="ca-apply-btn sa-generate-alt" data-src="${src}" data-page="${saEsc(page.url)}" data-idx="${idx}">✨ Suggest alt text</button>`;
  } else {
    actionHtml = `<button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc(issue.current)}">Copy details</button>`;
  }

  // Alt-text suggestions render as their own list once generated.
  const altHtml = issue.type === 'missing-alt' && gen
    ? `<div class="diff-preview">${(gen.altTexts || []).map(a => `<div class="diff-add">${saEsc(a.src.split('/').pop())}: "${saEsc(a.alt)}"</div>`).join('')}</div>
       <button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc((gen.altTexts || []).map(a => `${a.src} -> ${a.alt}`).join('\n'))}">Copy all alt text</button>`
    : '';

  return `
    <div class="cr-suggestion-block">
      <div class="serp-preview-label">${SEVERITY_LABEL[issue.severity] || issue.severity} &middot; ${saEsc(issue.type.replace(/-/g, ' '))}</div>
      <div class="ca-issue-reason">Why: ${saEsc(issue.reason)}</div>
      <div class="diff-preview">
        <div>Current: <span>${saEsc((issue.current || '').slice(0, 300))}</span></div>
        ${issue.suggested && issue.type !== 'duplicate-tags' ? `<div class="diff-add">Suggested: ${saEsc(issue.suggested)}</div>` : ''}
      </div>
      ${issue.type === 'missing-alt' ? (gen ? altHtml : actionHtml) : actionHtml}
      <div class="ca-result" hidden></div>
    </div>
  `;
}

function saRenderPage(siteSlug, page) {
  return `
    <div class="ca-page-card">
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
  container.querySelectorAll('.sa-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => saCopyToClipboard(btn.dataset.copy, btn));
  });
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
  if (!site.pages.length) {
    container.innerHTML = `<p class="empty">No technical issues found on this crawl.</p>${saRenderOrphans(site.orphans)}`;
  } else {
    container.innerHTML = site.pages.map(p => saRenderPage(siteSlug, p)).join('') + saRenderOrphans(site.orphans);
  }
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
// Apply-ability comes from matching a CSV row's URL against this site's
// `urlIndex` (every page the native crawl already resolved to a Wix
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

  const urlIndex = saData[siteSlug].urlIndex || [];
  const byUrl = new Map(urlIndex.map(e => [saNormUrl(e.url), e]));

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
        type: 'missing-h1', severity: 'high', applyable: false, needsAi: false,
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
