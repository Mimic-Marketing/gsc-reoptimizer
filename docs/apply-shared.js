// Shared "apply live" plumbing used by both content-audit-app.js (Meta
// Optimization) and content-reoptimize-app.js (Content Reoptimization) --
// one password prompt/session for both tabs, one result-panel renderer.

const WORKER_URL = 'https://gsc-reoptimizer-apply.mimic-marketing.workers.dev';
let sharedSessionPassword = null;

function applyEsc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function applyGetPassword() {
  if (sharedSessionPassword) return sharedSessionPassword;
  const pw = prompt('Password to apply live changes:');
  sharedSessionPassword = pw;
  return pw;
}

function applyForgetPassword() {
  sharedSessionPassword = null;
}

// Posts to a Worker endpoint, then renders a standard before/after result
// panel into `resultEl`. `formatValue` turns a raw previous/current field
// into display text (e.g. joining focus-keyword objects into a string).
//
// Undo, everywhere: pass `buildUndoPayload(data)` -- given the apply
// response, return the payload that would revert it (same shape as the
// original `payload`, just with before/after swapped). Works the same way
// for every apply across every tab: Meta Optimization re-POSTs
// /apply-seo-tags with the old title/meta/keywords/focusKeywords; Content
// Reoptimization/Internal Linking re-POST /apply-content-change with
// operation 'restore_content' and the richContent snapshot the Worker
// already returns as `previousRichContent`. If `buildUndoPayload` is
// omitted, no Undo button renders (there's nothing to revert to).
async function applyRun({ endpoint, payload, btn, resultEl, pageUrl, formatBefore, formatAfter, buildUndoPayload }) {
  const originalLabel = btn.textContent; // restored if Undo is used later -- see applyUndo
  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    const res = await fetch(`${WORKER_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    resultEl.hidden = false;
    resultEl.className = 'ca-result ok';
    resultEl.innerHTML = `
      <strong>Applied ${new Date(data.appliedAt).toLocaleTimeString()}</strong><br>
      Before: ${applyEsc(formatBefore(data.previous))}<br>
      After: ${applyEsc(formatAfter(data.current))}<br>
      <a href="${applyEsc(pageUrl)}" target="_blank">View live page &rarr;</a>
      ${buildUndoPayload ? '<br><button class="ca-apply-btn undo-btn" style="margin-top:.5rem;background:var(--red)">Undo this change</button>' : ''}
    `;
    btn.textContent = 'Applied';

    if (buildUndoPayload) {
      resultEl.querySelector('.undo-btn').addEventListener('click', async (e) => {
        await applyUndo(endpoint, buildUndoPayload, data, pageUrl, e.target, resultEl, btn, originalLabel);
      });
    }
    return true;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = 'ca-result error';
    resultEl.textContent = `Failed: ${err.message}`;
    btn.disabled = false;
    btn.textContent = 'Apply live';
    if (err.message.includes('password') || err.message.includes('401')) applyForgetPassword();
    return false;
  }
}

// Generic Undo: re-POSTs the same endpoint with whatever payload
// `buildUndoPayload(data)` computes (async, so it can re-prompt for the
// password if the session forgot it). On success, resets the ORIGINAL
// Apply button back to its clickable label -- it was left disabled/
// "Applied" after the apply succeeded, and a successful Undo means that's
// no longer true: the page is back to its pre-apply state, so Apply should
// be usable again.
async function applyUndo(endpoint, buildUndoPayload, applyResponseData, pageUrl, btn, resultEl, applyBtn, applyOriginalLabel) {
  btn.disabled = true;
  btn.textContent = 'Undoing...';
  try {
    const undoPayload = await buildUndoPayload(applyResponseData);
    if (!undoPayload) { btn.disabled = false; btn.textContent = 'Undo this change'; return; } // e.g. password prompt was cancelled

    const res = await fetch(`${WORKER_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(undoPayload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    resultEl.className = 'ca-result ok';
    resultEl.innerHTML = `Restored to before this change. <a href="${applyEsc(pageUrl)}" target="_blank">View live page &rarr;</a>`;
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = applyOriginalLabel || 'Apply live';
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Undo this change';
    alert(`Undo failed: ${err.message}`);
    if (err.message.includes('password') || err.message.includes('401')) applyForgetPassword();
  }
}

// ---------- AI suggestion generation (on-demand, via the Worker) ----------
//
// The Worker holds the AI provider's API key server-side (Settings modal
// below writes it there); this only ever sends the raw page/GSC data needed
// to build the prompt. Results are cached in localStorage per page+type so
// re-viewing a page doesn't re-spend a call -- pass `force: true` to bypass
// the cache (a "Regenerate" action).
function applySuggestionCacheKey(type, pageUrl, extra) {
  return `aiSuggestion:${type}:${pageUrl}${extra ? `:${extra}` : ''}`;
}

// Synchronous, no network, no password prompt -- lets a page re-render
// already-generated suggestions the moment data loads (e.g. after a
// refresh), instead of showing "click Generate" again for something that
// was already generated in this browser. Returns null on a cache miss.
function applyPeekCachedSuggestion(type, pageUrl, cacheSuffix) {
  try {
    const cached = localStorage.getItem(applySuggestionCacheKey(type, pageUrl, cacheSuffix));
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

async function applyGenerateSuggestion(type, pageUrl, data, { force = false, cacheSuffix = '' } = {}) {
  const cacheKey = applySuggestionCacheKey(type, pageUrl, cacheSuffix);
  if (!force) {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* localStorage unavailable -- just regenerate */ }
  }

  const password = await applyGetPassword();
  if (!password) throw new Error('Password required');

  const res = await fetch(`${WORKER_URL}/generate-suggestion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, password, ...data }),
  });
  const body = await res.json();
  if (!res.ok) {
    if (res.status === 401) applyForgetPassword();
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  try { localStorage.setItem(cacheKey, JSON.stringify(body.result)); } catch { /* quota/private-mode -- suggestion still returned, just not cached */ }
  return body.result;
}

// ---------- AI provider Settings modal ----------

async function applyInitSettingsModal() {
  const btn = document.getElementById('ai-settings-btn');
  const modal = document.getElementById('ai-settings-modal');
  const statusEl = document.getElementById('ai-settings-status');
  const providerSelect = document.getElementById('ai-settings-provider');
  const keyInput = document.getElementById('ai-settings-key');
  const resultEl = document.getElementById('ai-settings-result');
  const saveBtn = document.getElementById('ai-settings-save');

  async function refreshStatus() {
    try {
      const res = await fetch(`${WORKER_URL}/settings-status`);
      const data = await res.json();
      statusEl.textContent = data.configured
        ? `Currently configured: ${data.provider}. Saving again will overwrite it.`
        : 'No provider configured yet -- suggestions will show "no AI provider configured" until you save one.';
      if (data.provider) providerSelect.value = data.provider;
    } catch {
      statusEl.textContent = 'Could not reach the Worker to check status.';
    }
  }

  btn.addEventListener('click', () => {
    modal.hidden = false;
    resultEl.hidden = true;
    refreshStatus();
  });
  document.getElementById('ai-settings-cancel').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });

  saveBtn.addEventListener('click', async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) { resultEl.hidden = false; resultEl.className = 'ca-result error'; resultEl.textContent = 'Enter an API key first.'; return; }
    const password = await applyGetPassword();
    if (!password) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const res = await fetch(`${WORKER_URL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, provider: providerSelect.value, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      resultEl.hidden = false;
      resultEl.className = 'ca-result ok';
      resultEl.textContent = `Saved -- ${data.provider} is now configured.`;
      keyInput.value = '';
      refreshStatus();
    } catch (err) {
      resultEl.hidden = false;
      resultEl.className = 'ca-result error';
      resultEl.textContent = `Failed: ${err.message}`;
      if (err.message.includes('password') || err.message.includes('401')) applyForgetPassword();
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });
}

document.addEventListener('DOMContentLoaded', applyInitSettingsModal);
