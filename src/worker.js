const UA =
  'Mozilla/5.0 (compatible; SocialSharePreview/1.0; +https://social-share.mazaryk.com) facebookexternalhit/1.1';

const MAX_HTML_BYTES = 3_000_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/preview') {
      return preview(url);
    }
    if (url.pathname === '/') {
      const wantsJson =
        url.searchParams.get('format') === 'json' ||
        (request.headers.get('accept') || '').includes('application/json');
      if (wantsJson && url.searchParams.get('url')) {
        return preview(url);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function preview(reqUrl) {
  let raw = (reqUrl.searchParams.get('url') || '').trim();
  if (!raw) return json({ error: 'Missing url parameter' }, 400);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;

  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'Invalid URL' }, 400);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return json({ error: 'Only http(s) URLs are supported' }, 400);
  }

  let res;
  try {
    res = await fetch(target.href, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    return json({ error: `Could not fetch page: ${e.message}` }, 502);
  }

  const contentType = res.headers.get('content-type') || '';
  const result = {
    requestedUrl: target.href,
    finalUrl: res.url || target.href,
    status: res.status,
    contentType,
    title: null,
    meta: [],
    links: [],
    image: null,
  };

  if (!/html/i.test(contentType)) {
    try {
      await res.body?.cancel();
    } catch {}
    return json({ ...result, error: 'URL did not return an HTML page' });
  }

  let titleBuf = '';
  let titleDone = false;

  const a11y = {
    lang: null,
    images: { total: 0, missingAlt: 0, emptyAlt: 0 },
    landmarks: {},
    headings: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    aria: {},
    roles: {},
    inputs: { total: 0, labeled: 0 },
    iframes: { total: 0, withTitle: 0 },
  };
  let labelDepth = 0;
  let inputsAriaLabeled = 0;
  let inputsWrapped = 0;
  const inputIds = [];
  const labelFor = new Set();

  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        const tag = el.tagName;
        for (const [name, value] of el.attributes) {
          if (name.startsWith('aria-')) {
            a11y.aria[name] = (a11y.aria[name] || 0) + 1;
          } else if (name === 'role') {
            for (const r of value.trim().toLowerCase().split(/\s+/)) {
              if (r) a11y.roles[r] = (a11y.roles[r] || 0) + 1;
            }
          }
        }
        switch (tag) {
          case 'html':
            if (a11y.lang == null) a11y.lang = el.getAttribute('lang');
            break;
          case 'img': {
            a11y.images.total++;
            const alt = el.getAttribute('alt');
            if (alt == null) a11y.images.missingAlt++;
            else if (!alt.trim()) a11y.images.emptyAlt++;
            break;
          }
          case 'main':
          case 'nav':
          case 'header':
          case 'footer':
          case 'aside':
            a11y.landmarks[tag] = true;
            break;
          case 'h1':
          case 'h2':
          case 'h3':
          case 'h4':
          case 'h5':
          case 'h6':
            a11y.headings[tag]++;
            break;
          case 'label': {
            const f = el.getAttribute('for');
            if (f) labelFor.add(f);
            labelDepth++;
            try {
              el.onEndTag(() => {
                labelDepth = Math.max(0, labelDepth - 1);
              });
            } catch {
              labelDepth = Math.max(0, labelDepth - 1);
            }
            break;
          }
          case 'input':
          case 'select':
          case 'textarea': {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (tag === 'input' && ['hidden', 'submit', 'reset', 'button', 'image'].includes(type)) break;
            a11y.inputs.total++;
            if (
              el.getAttribute('aria-label') ||
              el.getAttribute('aria-labelledby') ||
              el.getAttribute('title')
            ) {
              inputsAriaLabeled++;
            } else if (labelDepth > 0) {
              inputsWrapped++;
            } else {
              const id = el.getAttribute('id');
              if (id) inputIds.push(id);
            }
            break;
          }
          case 'iframe':
            a11y.iframes.total++;
            if (el.getAttribute('title')) a11y.iframes.withTitle++;
            break;
        }
      },
    })
    .on('meta', {
      element(el) {
        const key =
          el.getAttribute('property') ||
          el.getAttribute('name') ||
          el.getAttribute('itemprop');
        const content = el.getAttribute('content');
        if (key && content != null) {
          result.meta.push({ key, content });
        }
      },
    })
    .on('head > title', {
      element() {
        if (titleBuf) titleDone = true;
      },
      text(t) {
        if (!titleDone) titleBuf += t.text;
      },
    })
    .on('link', {
      element(el) {
        const rel = (el.getAttribute('rel') || '').toLowerCase().trim();
        const href = el.getAttribute('href');
        if (!href) return;
        if (
          ['icon', 'shortcut icon', 'apple-touch-icon', 'canonical', 'alternate'].includes(rel)
        ) {
          result.links.push({ rel, href, type: el.getAttribute('type') || null });
        }
      },
    });

  try {
    const transformed = rewriter.transform(res);
    const reader = transformed.body.getReader();
    let bytes = 0;
    while (bytes < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    await reader.cancel().catch(() => {});
  } catch (e) {
    return json({ ...result, error: `Failed to parse page: ${e.message}` });
  }

  result.title = titleBuf.replace(/\s+/g, ' ').trim() || null;

  a11y.inputs.labeled =
    inputsAriaLabeled + inputsWrapped + inputIds.filter((id) => labelFor.has(id)).length;
  result.a11y = a11y;

  // Check that the share image actually resolves.
  const metaMap = {};
  for (const { key, content } of result.meta) {
    const k = key.toLowerCase();
    if (!(k in metaMap)) metaMap[k] = content;
  }
  const imgRaw =
    metaMap['og:image'] ||
    metaMap['og:image:url'] ||
    metaMap['og:image:secure_url'] ||
    metaMap['twitter:image'] ||
    metaMap['twitter:image:src'];
  if (imgRaw) {
    let imgUrl = null;
    try {
      imgUrl = new URL(imgRaw, result.finalUrl).href;
    } catch {
      result.image = { url: imgRaw, ok: false, error: 'Invalid image URL' };
    }
    if (imgUrl) {
      result.image = await checkImage(imgUrl);
    }
  }

  result.score = computeScore(result, metaMap);
  result.platforms = computePlatforms(result, metaMap);

  return json(result);
}

function computeScore(result, m) {
  const has = (k) => !!(m[k] && m[k].trim());
  const checks = [
    { id: 'og-title', label: 'og:title', pts: 12, pass: has('og:title') },
    { id: 'og-description', label: 'og:description', pts: 12, pass: has('og:description') },
    { id: 'og-image', label: 'og:image', pts: 16, pass: has('og:image') || has('og:image:url') },
    { id: 'image-loads', label: 'Share image loads', pts: 8, pass: !!(result.image && result.image.ok) },
    { id: 'og-url', label: 'og:url', pts: 4, pass: has('og:url') },
    { id: 'og-type', label: 'og:type', pts: 4, pass: has('og:type') },
    { id: 'og-site-name', label: 'og:site_name', pts: 4, pass: has('og:site_name') },
    { id: 'og-image-size', label: 'og:image size hints', pts: 4, pass: has('og:image:width') && has('og:image:height') },
    { id: 'twitter-card', label: 'twitter:card', pts: 10, pass: has('twitter:card') },
    { id: 'x-title', label: 'X title (or og fallback)', pts: 4, pass: has('twitter:title') || has('og:title') },
    { id: 'x-description', label: 'X description (or og fallback)', pts: 4, pass: has('twitter:description') || has('og:description') },
    { id: 'x-image', label: 'X image (or og fallback)', pts: 6, pass: has('twitter:image') || has('og:image') },
    { id: 'html-title', label: '<title> tag', pts: 6, pass: !!(result.title && result.title.trim()) },
    { id: 'meta-description', label: 'meta description', pts: 6, pass: has('description') },
  ];
  const total = checks.reduce((s, c) => s + (c.pass ? c.pts : 0), 0);
  let grade, label;
  if (total >= 90) { grade = 'A'; label = 'Excellent'; }
  else if (total >= 75) { grade = 'B'; label = 'Good'; }
  else if (total >= 60) { grade = 'C'; label = 'Fair'; }
  else if (total >= 40) { grade = 'D'; label = 'Poor'; }
  else { grade = 'F'; label = 'Missing'; }
  return { total, grade, label, checks };
}

function computePlatforms(result, m) {
  const has = (k) => !!(m[k] && m[k].trim());
  const ogTitle = has('og:title');
  const ogDesc = has('og:description');
  const ogImg = has('og:image') || has('og:image:url');
  const twCard = has('twitter:card');
  const htmlTitle = !!(result.title && result.title.trim());
  const ogCount = [ogTitle, ogDesc, ogImg].filter(Boolean).length;

  const level = (present, needed) => (present >= needed ? 'full' : present > 0 ? 'partial' : 'none');

  let xLevel, xNote;
  if (twCard) {
    const xBits = [has('twitter:title') || ogTitle, has('twitter:image') || ogImg].filter(Boolean).length;
    xLevel = xBits === 2 ? 'full' : 'partial';
    xNote = xBits === 2 ? 'twitter:card + full data' : 'twitter:card present, missing title or image';
  } else if (ogCount > 0) {
    xLevel = 'partial';
    xNote = 'No twitter:card — card may not render';
  } else {
    xLevel = 'none';
    xNote = 'No twitter:card or Open Graph tags';
  }

  const pair = [ogTitle, ogImg].filter(Boolean).length;
  return [
    { name: 'Facebook', level: level(ogCount, 3),
      note: ogCount === 3 ? 'Full Open Graph data' : ogCount ? 'Partial Open Graph data' : htmlTitle ? 'Falls back to page title' : 'Nothing to show' },
    { name: 'X (Twitter)', level: xLevel, note: xNote },
    { name: 'LinkedIn', level: level(pair, 2),
      note: pair === 2 ? 'Uses Open Graph tags' : pair ? 'Missing og:title or og:image' : 'Falls back to page scrape' },
    { name: 'WhatsApp', level: level(pair, 2),
      note: pair === 2 ? 'Rich link preview' : ogTitle ? 'Text-only preview' : 'Plain link' },
    { name: 'Discord', level: level(ogCount, 3),
      note: ogCount === 3 ? 'Full embed' : ogCount ? 'Partial embed' : 'Plain link' },
    { name: 'Telegram', level: level(pair, 2),
      note: pair === 2 ? 'Rich link preview' : ogTitle ? 'Text-only preview' : 'Plain link' },
    { name: 'Slack', level: level([ogTitle || htmlTitle, ogDesc || has('description')].filter(Boolean).length, 2),
      note: ogTitle ? 'Unfurls with Open Graph' : htmlTitle ? 'Unfurls from HTML title' : 'No unfurl' },
    { name: 'Pinterest', level: ogImg ? (ogTitle ? 'full' : 'partial') : 'none',
      note: ogImg ? 'Pinnable with rich data' : 'Needs og:image' },
  ];
}

async function checkImage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
    });
    const info = {
      url,
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type'),
      contentLength: Number(res.headers.get('content-length')) || null,
    };
    try {
      await res.body?.cancel();
    } catch {}
    return info;
  } catch (e) {
    return { url, ok: false, error: e.message };
  }
}
