// SEO Audit tab. A Screaming-Frog-style technical crawl of every page on
// the site (not just GSC-underperforming ones) -- fully independent of
// app.js, shares the page's password lock and apply-live plumbing
// (apply-shared.js) with the other tabs. No period selector: this is a
// point-in-time technical snapshot, not a GSC-window comparison.
//
// Two issue types are live-Applyable (canonical, duplicate-tags), both via
// the existing /apply-seo-tags endpoint -- Undo comes free from that
// endpoint's existing snapshot/restore, same as Meta Optimization. Every
// other issue type (broken-link, redirect-chain, missing-h1, multiple-h1,
// missing-alt) is report-only: Copy button, no Apply.

let saLoaded = false;
let saData = null;
const saGenerated = {}; // `${pageUrl}:${issueIdx}` -> generated result

function saEsc(s) { return applyEsc(s); }

function saShortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/ (home)' : u.pathname;
  } catch {
    return url;
  }
}

function saGenKey(page, idx) { return `${page.url}:${idx}`; }

function saCopyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

async function saGenerateDuplicateTags(siteSlug, page, issue, idx, btn) {
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
    saRenderSite(siteSlug);
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

  let actionHtml;
  if (issue.type === 'duplicate-tags') {
    actionHtml = gen
      ? `<div class="diff-preview">
           ${issue.titleDup ? `<div class="diff-add">Title: ${saEsc(gen.title)}</div><div class="ca-issue-reason">${saEsc(gen.titleReason)}</div>` : ''}
           ${issue.metaDup ? `<div class="diff-add">Meta: ${saEsc(gen.metaDescription)}</div><div class="ca-issue-reason">${saEsc(gen.metaReason)}</div>` : ''}
         </div>
         ${page.matched ? `<button class="ca-apply-btn sa-apply-dup" data-page="${saEsc(page.url)}" data-idx="${idx}">Apply live</button>` : ''}`
      : `<button class="ca-apply-btn sa-generate-dup" data-page="${saEsc(page.url)}" data-idx="${idx}">✨ Generate fix</button>`;
  } else if (issue.type === 'missing-canonical' || issue.type === 'canonical-mismatch') {
    actionHtml = page.matched
      ? `<button class="ca-apply-btn sa-apply-canonical" data-page="${saEsc(page.url)}" data-idx="${idx}">Apply live (set canonical)</button>`
      : `<button class="ca-apply-btn sa-copy-btn" data-copy="${saEsc(issue.suggested)}">Copy suggested canonical</button>`;
  } else if (issue.type === 'missing-alt') {
    actionHtml = `<button class="ca-apply-btn sa-generate-alt" data-page="${saEsc(page.url)}" data-idx="${idx}">✨ Suggest alt text</button>`;
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
      </div>
      ${page.issues.map((issue, i) => saRenderIssue(siteSlug, page, issue, i)).join('')}
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
  if (!site.pages.length) {
    document.getElementById('sa-page-list').innerHTML = `<p class="empty">No technical issues found on this crawl.</p>${saRenderOrphans(site.orphans)}`;
    return;
  }
  document.getElementById('sa-page-list').innerHTML = site.pages.map(p => saRenderPage(siteSlug, p)).join('') + saRenderOrphans(site.orphans);

  document.querySelectorAll('.sa-generate-dup').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saGenerateDuplicateTags(siteSlug, page, page.issues[idx], idx, btn);
    });
  });
  document.querySelectorAll('.sa-apply-dup').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saApplyDuplicateTags(siteSlug, page, page.issues[idx], idx, btn);
    });
  });
  document.querySelectorAll('.sa-apply-canonical').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      saApplyCanonical(siteSlug, page, page.issues[idx], btn);
    });
  });
  document.querySelectorAll('.sa-generate-alt').forEach(btn => {
    btn.addEventListener('click', async () => {
      const page = site.pages.find(p => p.url === btn.dataset.page);
      const idx = Number(btn.dataset.idx);
      const issue = page.issues[idx];
      btn.disabled = true;
      btn.textContent = 'Generating...';
      try {
        const result = await applyGenerateSuggestion('alt', page.url, {
          pageUrl: page.url, currentTitle: page.currentTitle, images: issue.images,
        }, { cacheSuffix: `alt-${idx}` });
        saGenerated[saGenKey(page, idx)] = result;
        saRenderSite(siteSlug);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '✨ Suggest alt text';
        alert(`Failed to generate suggestion: ${err.message}`);
      }
    });
  });
  document.querySelectorAll('.sa-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => saCopyToClipboard(btn.dataset.copy, btn));
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
  saLoadAll().catch(err => {
    document.getElementById('sa-page-list').innerHTML = `<p class="ca-result error" style="display:block">Failed to load: ${saEsc(err.message)}</p>`;
  });
};
