const UA =
  'Mozilla/5.0 (compatible; SocialSharePreview/1.0; +https://social-share.mazaryk.com) facebookexternalhit/1.1';

const MAX_HTML_BYTES = 3_000_000;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/preview') {
      return preview(url);
    }
    return json({ error: 'Not found' }, 404);
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

  return json(result);
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
