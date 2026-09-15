// Backend for the Content Audit tab's "Apply live" buttons. Holds the
// write-capable Wix Admin API key server-side -- this is the whole reason
// the Worker exists, since GitHub Pages has no server and a write key can
// never sit in client JS. The static page calls this Worker; this Worker
// calls Wix.

const SITES = {
  mimicminds: '1d570b1b-ba44-4cdd-bb4b-176a7afb7d75',
  mimicproductions: '20db1d0f-b8d3-49e6-8100-03577875df69',
};

const ALLOWED_ORIGIN = 'https://mimic-marketing.github.io';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function wixFetch(env, siteId, path, options = {}) {
  return fetch(`https://www.wixapis.com${path}`, {
    ...options,
    headers: {
      Authorization: env.WIX_API_KEY,
      'Content-Type': 'application/json',
      'wix-site-id': siteId,
      ...(options.headers || {}),
    },
  });
}

function extractTag(tags, type, propsName) {
  const tag = propsName
    ? tags.find(t => t.type === type && t.props?.name === propsName)
    : tags.find(t => t.type === type);
  if (!tag) return null;
  // Wix's `meta` tags always carry `children: ""` (empty) alongside the
  // real text in `props.content` -- `??` only skips null/undefined, not
  // empty string, so it was silently preferring the always-empty
  // `children` over the actual content. `||` correctly falls through.
  return tag.children || tag.props?.content || null;
}

function extractCanonicalTag(tags) {
  const tag = tags.find(t => t.type === 'link' && t.props?.rel === 'canonical');
  return tag?.props?.href || null;
}

function mergeTags(existingTags, { title, metaDescription, metaKeywords, canonical }) {
  const tags = existingTags.filter(t => {
    if (title !== undefined && t.type === 'title') return false;
    if (metaDescription !== undefined && t.type === 'meta' && t.props?.name === 'description') return false;
    if (metaKeywords !== undefined && t.type === 'meta' && t.props?.name === 'keywords') return false;
    if (canonical !== undefined && t.type === 'link' && t.props?.rel === 'canonical') return false;
    return true;
  });
  if (title !== undefined) tags.push({ type: 'title', children: title });
  if (metaDescription !== undefined) {
    tags.push({ type: 'meta', props: { name: 'description', content: metaDescription } });
  }
  if (metaKeywords !== undefined) {
    tags.push({ type: 'meta', props: { name: 'keywords', content: metaKeywords } });
  }
  if (canonical !== undefined) {
    tags.push({ type: 'link', props: { rel: 'canonical', href: canonical } });
  }
  return tags;
}

// ---------- Content Reoptimization: body-content live-write ----------
//
// Only two Ricos edits are ever attempted, both structurally additive so
// they can't corrupt existing content: appending a whole new paragraph node,
// and splitting one existing TEXT node to wrap an exact anchor-text match in
// a LINK decoration. Anything that would need re-splicing existing text in
// place (an in-line keyword rewrite) is deliberately NOT supported here --
// see the Content Reoptimization plan for why.

function newNodeId() {
  return crypto.randomUUID();
}

function findTextNodeMatches(nodes, anchorText, matches = []) {
  for (const node of nodes || []) {
    if (node.type === 'TEXT' && node.textData?.text?.includes(anchorText)) {
      matches.push(node);
    }
    if (node.nodes?.length) findTextNodeMatches(node.nodes, anchorText, matches);
  }
  return matches;
}

// Replaces `target` (a TEXT node found by findTextNodeMatches) in its parent
// array with up to 3 TEXT nodes: unlinked-before, linked-anchor, unlinked-
// after. Only the exact matched substring gets the LINK decoration.
function splitAndLinkNode(nodesArray, target, anchorText, targetUrl) {
  const idx = nodesArray.indexOf(target);
  if (idx === -1) return false;
  const text = target.textData.text;
  const start = text.indexOf(anchorText);
  const before = text.slice(0, start);
  const match = text.slice(start, start + anchorText.length);
  const after = text.slice(start + anchorText.length);
  const baseDecorations = target.textData.decorations || [];

  const replacement = [];
  if (before) replacement.push({ id: newNodeId(), type: 'TEXT', textData: { text: before, decorations: baseDecorations } });
  replacement.push({
    id: newNodeId(),
    type: 'TEXT',
    textData: {
      text: match,
      decorations: [...baseDecorations, { type: 'LINK', linkData: { link: { url: targetUrl, target: 'SELF' } } }],
    },
  });
  if (after) replacement.push({ id: newNodeId(), type: 'TEXT', textData: { text: after, decorations: baseDecorations } });

  nodesArray.splice(idx, 1, ...replacement);
  return true;
}

function buildParagraphNode(text) {
  return {
    id: newNodeId(),
    type: 'PARAGRAPH',
    nodes: [{ id: newNodeId(), type: 'TEXT', textData: { text, decorations: [] } }],
    paragraphData: {},
  };
}

// Recursively collects all TEXT node text under a node (a PARAGRAPH's own
// text lives one level down, inside its TEXT children).
function flattenNodeText(node) {
  if (!node) return '';
  if (node.type === 'TEXT') return node.textData?.text || '';
  return (node.nodes || []).map(flattenNodeText).join('');
}

// Posts commonly end with a boilerplate contact/signature line (e.g. "For
// further information ... contact ... info@..."). Landing a new SEO
// paragraph AFTER that reads as structurally wrong -- keep in sync with the
// same heuristic in docs/content-reoptimize-app.js, which uses it to render
// an accurate before/after preview of where the paragraph actually lands.
const SIGNATURE_LINE_RE = /contact|info@|for further information|please reach out|get in touch/i;

function isSignatureParagraph(node) {
  const text = flattenNodeText(node);
  return text.length > 0 && text.length < 400 && SIGNATURE_LINE_RE.test(text);
}

// Finds the node index just before the NEXT heading after the one matching
// `headingText` exactly -- i.e. the end of that heading's section, a safe
// place to add a new paragraph without disturbing anything. Requires an
// exact, unambiguous match (exactly one HEADING node with this text);
// returns null otherwise so the caller falls back to end-of-post placement
// rather than guessing which section was meant.
function findSectionInsertIndex(nodes, headingText) {
  const target = headingText.trim();
  const matches = [];
  nodes.forEach((n, i) => { if (n.type === 'HEADING' && flattenNodeText(n).trim() === target) matches.push(i); });
  if (matches.length !== 1) return null;
  for (let i = matches[0] + 1; i < nodes.length; i++) {
    if (nodes[i].type === 'HEADING') return i;
  }
  return nodes.length;
}

async function handleApplyContent(request, env) {
  const body = await request.json();
  const { site, postId, password, operation, paragraphText, insertAfterHeading, anchorText, targetUrl, pageUrl } = body;

  if (password !== env.ACTION_PASSWORD) {
    return json({ error: 'Wrong password' }, 401);
  }
  const siteId = SITES[site];
  if (!siteId) return json({ error: `Unknown site: ${site}` }, 400);
  if (!postId) return json({ error: 'Missing postId' }, 400);

  // restore_content (Undo): the frontend hands back the exact richContent
  // this endpoint returned as `previousRichContent` on a prior apply --
  // write it back verbatim, no diffing, no re-reading current state. This
  // is the ONLY path that skips the "did we actually get real content"
  // guard below, since the caller is explicitly supplying a known-good
  // snapshot rather than asking us to trust a fresh GET.
  if (operation === 'restore_content') {
    if (!body.richContent) return json({ error: 'Missing richContent to restore' }, 400);
    const patchRes = await wixFetch(env, siteId, `/blog/v3/draft-posts/${postId}`, {
      method: 'PATCH',
      body: JSON.stringify({ draftPost: { id: postId, richContent: body.richContent } }),
    });
    if (!patchRes.ok) return json({ error: `Wix write failed: ${patchRes.status} ${await patchRes.text()}` }, 502);
    const publishRes = await wixFetch(env, siteId, `/blog/v3/draft-posts/${postId}/publish`, { method: 'POST' });
    if (!publishRes.ok) return json({ error: `Wix publish failed: ${publishRes.status} ${await publishRes.text()}` }, 502);
    return json({ ok: true, restored: true, pageUrl: pageUrl || null, appliedAt: new Date().toISOString() });
  }

  // GetDraftPost's DEFAULT response omits richContent entirely (confirmed
  // live -- the field is simply absent, not an empty object). An earlier
  // version of this endpoint read `draft.richContent || { nodes: [] }`,
  // which silently treated a real, non-empty post as blank and then
  // overwrote the live post with just the new paragraph -- a real
  // data-loss incident. `fieldsets=RICH_CONTENT` is required to actually
  // get the content back, and even then this code refuses to proceed if
  // the field is still missing, rather than ever guessing it's empty.
  const getRes = await wixFetch(env, siteId, `/blog/v3/draft-posts/${postId}?fieldsets=RICH_CONTENT`);
  if (!getRes.ok) {
    return json({ error: `Wix read failed: ${getRes.status} ${await getRes.text()}` }, 502);
  }
  const draft = (await getRes.json()).draftPost;
  if (draft.richContent === undefined || draft.richContent === null) {
    return json({ error: 'Wix did not return this post\'s content (richContent missing from response) -- refusing to write, since that would risk overwriting real content with nothing. No changes were made.' }, 502);
  }
  const richContent = draft.richContent;
  const previousRichContent = JSON.parse(JSON.stringify(richContent)); // full snapshot, for Undo -- taken before any mutation below

  let previous, current;

  if (operation === 'append_paragraph') {
    if (!paragraphText) return json({ error: 'Missing paragraphText' }, 400);
    previous = { paragraphCount: richContent.nodes.length };
    const newNode = buildParagraphNode(paragraphText);

    // Section-targeted insertion: find the (single, exact-match) HEADING
    // node and insert at the end of ITS section, i.e. right before the
    // next heading -- reads as a natural addition to that section instead
    // of always landing at the end of the whole post. Falls back to the
    // old end-of-post behavior (still signature-line-aware) if no heading
    // was requested, or it doesn't match exactly one heading -- never an
    // error, since the fallback is itself a safe, valid placement.
    let insertIdx = insertAfterHeading ? findSectionInsertIndex(richContent.nodes, insertAfterHeading) : null;
    let insertedBeforeClosingLine = false;
    if (insertIdx === null) insertIdx = richContent.nodes.length;
    if (insertIdx >= richContent.nodes.length) {
      const lastNode = richContent.nodes[richContent.nodes.length - 1];
      if (lastNode && isSignatureParagraph(lastNode)) {
        insertIdx = richContent.nodes.length - 1;
        insertedBeforeClosingLine = true;
      } else {
        insertIdx = richContent.nodes.length;
      }
    }
    richContent.nodes.splice(insertIdx, 0, newNode);
    current = { addedParagraph: paragraphText, insertedBeforeClosingLine, insertedAfterHeading: insertIdx < richContent.nodes.length - 1 ? insertAfterHeading || null : null };
  } else if (operation === 'add_internal_link') {
    if (!anchorText || !targetUrl) return json({ error: 'Missing anchorText/targetUrl' }, 400);
    const matches = findTextNodeMatches(richContent.nodes, anchorText);
    if (matches.length !== 1) {
      return json({
        error: matches.length === 0
          ? 'Anchor text not found -- the post content changed since this suggestion was generated. Refresh Content Reoptimization and retry.'
          : 'Anchor text appears more than once -- ambiguous, refusing to guess which one to link.',
      }, 409);
    }
    // Re-find the parent array holding this node (could be top-level or
    // nested inside e.g. a paragraph's own nodes array).
    function replaceInTree(nodes) {
      if (nodes.includes(matches[0])) return splitAndLinkNode(nodes, matches[0], anchorText, targetUrl);
      for (const n of nodes) {
        if (n.nodes?.length && replaceInTree(n.nodes)) return true;
      }
      return false;
    }
    const linked = replaceInTree(richContent.nodes);
    if (!linked) return json({ error: 'Could not locate anchor text node in document tree' }, 500);
    previous = { anchorText, linked: false };
    current = { anchorText, targetUrl, linked: true };
  } else {
    return json({ error: `Unknown operation: ${operation}` }, 400);
  }

  const patchRes = await wixFetch(env, siteId, `/blog/v3/draft-posts/${postId}`, {
    method: 'PATCH',
    body: JSON.stringify({ draftPost: { id: postId, richContent } }),
  });
  if (!patchRes.ok) {
    return json({ error: `Wix write failed: ${patchRes.status} ${await patchRes.text()}` }, 502);
  }

  const publishRes = await wixFetch(env, siteId, `/blog/v3/draft-posts/${postId}/publish`, { method: 'POST' });
  if (!publishRes.ok) {
    return json({ error: `Wix publish failed: ${publishRes.status} ${await publishRes.text()}` }, 502);
  }

  return json({ ok: true, previous, current, previousRichContent, pageUrl: pageUrl || null, appliedAt: new Date().toISOString() });
}

// ---------- AI suggestion settings + generation ----------
//
// The API key for whichever text-generation provider the user picks (Gemini,
// OpenAI, or Claude) is stored server-side in Workers KV -- never in
// localStorage or a client-visible request -- and every suggestion call is
// made from here, with the key attached server-side. The frontend only ever
// sends the raw page/GSC data needed to build the prompt; it never sees or
// handles the key itself.

const SETTINGS_KEY = 'ai-settings'; // single global settings doc -- one-user tool, gated by ACTION_PASSWORD like everything else here

async function handleGetSettingsStatus(env) {
  const raw = await env.SETTINGS_KV.get(SETTINGS_KEY);
  if (!raw) return json({ configured: false, provider: null });
  const { provider } = JSON.parse(raw);
  return json({ configured: true, provider });
}

async function handleSaveSettings(request, env) {
  const { password, provider, apiKey } = await request.json();
  if (password !== env.ACTION_PASSWORD) return json({ error: 'Wrong password' }, 401);
  if (!['gemini', 'openai', 'anthropic'].includes(provider)) return json({ error: `Unknown provider: ${provider}` }, 400);
  if (!apiKey) return json({ error: 'Missing apiKey' }, 400);
  await env.SETTINGS_KV.put(SETTINGS_KEY, JSON.stringify({ provider, apiKey }));
  return json({ ok: true, provider });
}

// Strips markdown code fences if a model ignores the "JSON only" instruction
// and wraps its answer in ```json ... ``` anyway.
function parseJsonLoose(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(stripped);
}

async function callGemini(apiKey, prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');
  return parseJsonLoose(text);
}

async function callOpenAI(apiKey, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned no content');
  return parseJsonLoose(text);
}

async function callAnthropic(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `${prompt}\n\nRespond with JSON only, no markdown code fences.` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Anthropic returned no content');
  return parseJsonLoose(text);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Transient overload (503) / rate-limit (429) errors are common and usually
// resolve within a couple seconds -- retry a couple times with backoff
// before surfacing it to the user, instead of making every "high demand"
// blip a manual re-click.
async function callProvider(provider, apiKey, prompt) {
  const call = () => {
    if (provider === 'gemini') return callGemini(apiKey, prompt);
    if (provider === 'openai') return callOpenAI(apiKey, prompt);
    if (provider === 'anthropic') return callAnthropic(apiKey, prompt);
    throw new Error(`Unknown provider: ${provider}`);
  };
  const delays = [800, 2000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const transient = /\b(429|503)\b/.test(err.message);
      if (!transient || attempt >= delays.length) throw err;
      await sleep(delays[attempt]);
    }
  }
}

function buildMetaPrompt(d) {
  return `You are an SEO copywriter. Write a better <title> tag, meta description, and meta keywords for one web page, using only the real data below -- do not invent facts about the page.

Page URL: ${d.pageUrl}
Current title: ${d.currentTitle || '(none)'}
Current meta description: ${d.currentMeta || '(none)'}
Top Google Search Console query (this period): "${d.primary.query}" -- ${d.primary.impressions} impressions, position ${d.primary.position.toFixed(1)}, CTR ${(d.primary.ctr * 100).toFixed(2)}%
Other queries this page ranks for: ${(d.secondary || []).map(q => `"${q.query}"`).join(', ') || '(none)'}
${d.bodyExcerpt ? `Page content excerpt: ${d.bodyExcerpt.slice(0, 600)}` : ''}

Rules:
- Title: natural, specific to this page, includes the top query, <=60 characters, not keyword-stuffed, not a generic template.
- Meta description: <=155 characters, reads like real ad copy (a reason to click), includes the top query naturally, not a list of keywords.
- Do not just append "| query" to the existing title -- rewrite it to actually read well.
- Meta keywords: 5-8 comma-separated terms drawn from the actual queries above (primary + secondary), not invented ones.
- titleReason / metaReason / metaKeywordsReason: one sentence each, explaining what in the GSC data above drove this specific suggestion.

Respond with this exact JSON shape only: {"title": "...", "titleReason": "...", "metaDescription": "...", "metaReason": "...", "metaKeywords": "...", "metaKeywordsReason": "..."}`;
}

function buildLinksPrompt(d) {
  return `You are an SEO strategist. Suggest new internal links FROM one underperforming page, using only the real data below -- do not invent facts about the page or business.

Page: ${d.pageUrl}
Title: ${d.currentTitle || '(none)'}
Why this page needs help: ${d.cause === 'ranking-drop' ? 'its ranking position got worse this period' : d.cause === 'ctr-drop' ? 'its clicks fell without a matching drop in position' : 'its CTR is well below what pages at its position typically earn'}.

Internal links already on this page (do not suggest these again):
${(d.currentInternalLinks || []).slice(0, 30).map(l => `- "${l.anchorText}" -> ${l.href}`).join('\n') || '(none found)'}

Candidate target pages on this site (pick from this list only, do not invent URLs):
${(d.linkCandidates || []).map(u => `- ${u}`).join('\n')}

${d.bodyExcerpt ? `This page's body text (for picking a verbatim anchor phrase): ${d.bodyExcerpt.slice(0, 2000)}` : "This page's body text isn't available via API -- pick a natural short anchor phrase; it won't be auto-verified against the live page."}

Produce 1-3 suggestions, each: targetUrl (must be exactly one of the candidate URLs above), anchorText (a short natural phrase, 3-8 words${d.bodyExcerpt ? ' -- prefer one that appears verbatim in the body text above' : ''}), and reason (one sentence: why this link helps traffic/crawling/relevance for this specific underperforming page, grounded in the cause above).

Respond with this exact JSON shape only: {"suggestions": [{"targetUrl": "...", "anchorText": "...", "reason": "..."}]}`;
}

function buildContentPrompt(d) {
  const gaps = d.gscGaps || [];
  const headings = d.headings || [];
  return `You are an SEO content strategist. Suggest content improvements for one underperforming blog post, using only the real data below -- do not invent facts about the page or business.

Post title: ${d.currentTitle}
Post URL: ${d.pageUrl}
Why this post needs help: ${d.cause === 'ranking-drop' ? 'its ranking position got worse this period' : d.cause === 'ctr-drop' ? 'its clicks fell without a matching drop in position' : 'its CTR is well below what pages at its position typically earn'}.
Existing body text (do not repeat any of these sentences): ${(d.bodyExcerpt || '').slice(0, 3000)}

Existing section headings, in order (these are the ONLY valid values for insertAfterHeading below):
${headings.map(h => `- "${h.text}"`).join('\n') || '(no headings detected -- use insertAfterHeading: null for every paragraph)'}

Google Search Console queries this post already gets impressions for but the body text doesn't cover:
${gaps.map(q => `- "${q.query}" (${q.impressions} impressions, position ${q.position.toFixed(1)})`).join('\n') || '(none -- base suggestions on secondary queries only)'}

All queries this post ranks for (for context): ${(d.gscQueries || []).slice(0, 8).map(q => `"${q.query}"`).join(', ')}

Produce:
1. lsiKeywords: 3-5 secondary/LSI keyword phrases worth working into this post, each with a one-sentence reason grounded in the GSC data above.
2. paragraphs: NEW paragraphs (2-4 sentences each) to ADD to this post -- never a rewrite of anything existing, only new additions. Each one should target a different LSI keyword or query gap, and each needs an insertAfterHeading: the exact text of the existing heading (copied character-for-character from the list above) whose section this paragraph best fits at the end of, or null if it belongs at the end of the post instead. Every paragraph must match the post's existing tone/topic and contain NO sentence that duplicates or closely paraphrases the existing body text.

paragraphs is REQUIRED and must contain AT LEAST 1 entry -- never respond with an empty array. If you're unsure exactly which heading a paragraph belongs under, use insertAfterHeading: null (end of post) rather than omitting the paragraph. There is always at least one reasonable paragraph to suggest given the LSI keywords and query gaps above.

Respond with this exact JSON shape only: {"lsiKeywords": [{"term": "...", "reason": "..."}], "paragraphs": [{"text": "...", "reason": "...", "insertAfterHeading": "... or null"}]}`;
}

function buildDuplicateMetaPrompt(d) {
  return `You are an SEO copywriter. This page's title and/or meta description are IDENTICAL to other pages on the same site, which confuses search engines about which page to rank. Rewrite them to be distinct and specific to THIS page, using only the real data below -- do not invent facts about the page.

Page URL: ${d.pageUrl}
Current title: ${d.currentTitle || '(none)'}
Current meta description: ${d.currentMeta || '(none)'}
${d.titleDup ? 'The TITLE is duplicated on other pages -- it must change.' : 'The title is fine as-is, but include an updated value anyway for completeness.'}
${d.metaDup ? 'The META DESCRIPTION is duplicated on other pages -- it must change.' : 'The meta description is fine as-is, but include an updated value anyway for completeness.'}
${d.bodyExcerpt ? `Page content excerpt (use this to make the rewrite specific to this page): ${d.bodyExcerpt.slice(0, 600)}` : ''}

Rules:
- Title: natural, specific to this exact page's content, <=60 characters, not a generic template, clearly distinguishable from a near-identical page.
- Meta description: <=155 characters, reads like real ad copy specific to this page's content.
- Meta keywords: 5-8 comma-separated terms specific to this page.
- titleReason / metaReason / metaKeywordsReason: one sentence each.

Respond with this exact JSON shape only: {"title": "...", "titleReason": "...", "metaDescription": "...", "metaReason": "...", "metaKeywords": "...", "metaKeywordsReason": "..."}`;
}

function buildAltTextPrompt(d) {
  return `You are an SEO/accessibility writer. Write alt text for images on one web page that currently have none, using only the real data below -- do not invent facts about the page or images.

Page URL: ${d.pageUrl}
Page title: ${d.currentTitle || '(none)'}
Images missing alt text (by their src URL, in order on the page):
${(d.images || []).map(src => `- ${src}`).join('\n')}

Rules:
- One alt text per image, in the same order as the list above.
- Describe what the image most likely shows given the page's title/topic and its filename/URL -- concise (<=125 characters), specific, not "image of" or keyword-stuffed.
- If a filename gives no real signal (e.g. a random hash), write a short generic description grounded in the page's topic instead of guessing specifics you can't know.

Respond with this exact JSON shape only: {"altTexts": [{"src": "...", "alt": "...", "reason": "..."}]}`;
}

async function handleGenerateSuggestion(request, env) {
  const body = await request.json();
  if (body.password !== env.ACTION_PASSWORD) return json({ error: 'Wrong password' }, 401);

  const raw = await env.SETTINGS_KV.get(SETTINGS_KEY);
  if (!raw) return json({ error: 'No AI provider configured -- add an API key in Settings first.' }, 400);
  const { provider, apiKey } = JSON.parse(raw);

  let prompt;
  if (body.type === 'meta') prompt = buildMetaPrompt(body);
  else if (body.type === 'content') prompt = buildContentPrompt(body);
  else if (body.type === 'links') prompt = buildLinksPrompt(body);
  else if (body.type === 'alt') prompt = buildAltTextPrompt(body);
  else if (body.type === 'duplicate-tags') prompt = buildDuplicateMetaPrompt(body);
  else return json({ error: `Unknown suggestion type: ${body.type}` }, 400);

  try {
    const result = await callProvider(provider, apiKey, prompt);
    return json({ ok: true, provider, result });
  } catch (err) {
    return json({ error: `${provider} request failed: ${err.message}` }, 502);
  }
}

async function handleApply(request, env) {
  const body = await request.json();
  const { site, itemType, itemId, title, metaDescription, metaKeywords, canonical, focusKeywords, password, pageUrl } = body;

  if (password !== env.ACTION_PASSWORD) {
    return json({ error: 'Wrong password' }, 401);
  }
  const siteId = SITES[site];
  if (!siteId) return json({ error: `Unknown site: ${site}` }, 400);
  if (!itemType || !itemId) return json({ error: 'Missing itemType/itemId' }, 400);
  if (title === undefined && metaDescription === undefined && metaKeywords === undefined && canonical === undefined && focusKeywords === undefined) {
    return json({ error: 'Nothing to change' }, 400);
  }

  // 1. Read current state so we have a real "previous" snapshot and can
  //    merge into the full tags array (Wix replaces tags in full on write).
  const getRes = await wixFetch(env, siteId, `/promote/seo/v1/item-seo-tags/${itemType}/${itemId}`);
  if (!getRes.ok) {
    return json({ error: `Wix read failed: ${getRes.status} ${await getRes.text()}` }, 502);
  }
  const current = (await getRes.json()).itemSeoTags;
  const existingTags = current.tags || [];
  // resolvedTags is what the page actually renders with (inherited/pattern
  // defaults included) -- only used for an accurate "before" snapshot to
  // show the user; the write below merges into the raw `tags` array, which
  // is correct as-is (an item with no own tags should stay that way except
  // for the field being changed).
  const resolvedFlat = (current.resolvedTags || []).map(rt => rt.tag);

  const previous = {
    title: extractTag(existingTags, 'title') || extractTag(resolvedFlat, 'title'),
    metaDescription: extractTag(existingTags, 'meta', 'description') || extractTag(resolvedFlat, 'meta', 'description'),
    metaKeywords: extractTag(existingTags, 'meta', 'keywords') || extractTag(resolvedFlat, 'meta', 'keywords'),
    canonical: extractCanonicalTag(existingTags) || extractCanonicalTag(resolvedFlat),
    focusKeywords: current.focusKeywords || [],
  };

  // 2. Build the full replacement payload.
  const newTags = mergeTags(existingTags, { title, metaDescription, metaKeywords, canonical });
  const fieldMaskParts = [];
  if (title !== undefined || metaDescription !== undefined || metaKeywords !== undefined || canonical !== undefined) fieldMaskParts.push('tags');
  if (focusKeywords !== undefined) fieldMaskParts.push('focusKeywords');

  const patchBody = {
    itemSeoTags: {
      tags: newTags,
      ...(focusKeywords !== undefined ? { focusKeywords } : {}),
    },
    fieldMask: fieldMaskParts.join(','),
    publish: true, // static pages: goes straight to the live published revision
  };

  const patchRes = await wixFetch(env, siteId, `/promote/seo/v1/item-seo-tags/${itemType}/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(patchBody),
  });
  if (!patchRes.ok) {
    return json({ error: `Wix write failed: ${patchRes.status} ${await patchRes.text()}` }, 502);
  }
  const updated = (await patchRes.json()).itemSeoTags;

  return json({
    ok: true,
    previous,
    current: {
      title: title !== undefined ? title : previous.title,
      metaDescription: metaDescription !== undefined ? metaDescription : previous.metaDescription,
      metaKeywords: metaKeywords !== undefined ? metaKeywords : previous.metaKeywords,
      canonical: canonical !== undefined ? canonical : previous.canonical,
      focusKeywords: focusKeywords !== undefined ? focusKeywords : previous.focusKeywords,
    },
    pageUrl: pageUrl || null,
    appliedAt: new Date().toISOString(),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }
    if (url.pathname === '/apply-seo-tags' && request.method === 'POST') {
      try {
        return await handleApply(request, env);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    if (url.pathname === '/apply-content-change' && request.method === 'POST') {
      try {
        return await handleApplyContent(request, env);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    if (url.pathname === '/settings-status' && request.method === 'GET') {
      try {
        return await handleGetSettingsStatus(env);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    if (url.pathname === '/settings' && request.method === 'POST') {
      try {
        return await handleSaveSettings(request, env);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    if (url.pathname === '/generate-suggestion' && request.method === 'POST') {
      try {
        return await handleGenerateSuggestion(request, env);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    return json({ error: 'Not found' }, 404);
  },
};
