export default async function handler(req, res) {
  // Allow CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const { url } = req.query;
  if (!url) {
    res.status(400).json({ error: "Missing url parameter" });
    return;
  }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
    new URL(targetUrl); // validate
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": req.headers["accept"] || "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Referer": new URL(targetUrl).origin,
    };

    const fetchRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "follow",
    });

    const contentType = fetchRes.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html");

    // Forward safe headers
    const skipHeaders = new Set([
      "content-encoding", "transfer-encoding", "connection",
      "keep-alive", "upgrade", "x-frame-options",
      "content-security-policy", "strict-transport-security",
    ]);
    fetchRes.headers.forEach((val, key) => {
      if (!skipHeaders.has(key.toLowerCase())) {
        try { res.setHeader(key, val); } catch {}
      }
    });

    res.setHeader("X-Frame-Options", "SAMEORIGIN");

    if (isHtml) {
      let html = await fetchRes.text();
      const base = new URL(targetUrl).origin;
      const proxyBase = `/api/proxy?url=`;

      // Rewrite absolute URLs in href, src, action
      html = html.replace(
        /(href|src|action)=["'](https?:\/\/[^"']+)["']/gi,
        (_, attr, link) => `${attr}="${proxyBase}${encodeURIComponent(link)}"`
      );

      // Rewrite relative URLs
      html = html.replace(
        /(href|src|action)=["'](\/[^"']+)["']/gi,
        (_, attr, path) => `${attr}="${proxyBase}${encodeURIComponent(base + path)}"`
      );

      // Inject base tag and our helper script
      const inject = `
<base href="${base}/">
<script>
// Intercept fetch & XHR inside proxied page
const _proxyBase = '/api/proxy?url=';
const _origFetch = window.fetch;
window.fetch = function(input, init) {
  let url = typeof input === 'string' ? input : input.url;
  if (url && !url.startsWith('/api/proxy') && (url.startsWith('http') || url.startsWith('//'))) {
    url = _proxyBase + encodeURIComponent(url.startsWith('//') ? 'https:' + url : url);
    return _origFetch(url, init);
  }
  return _origFetch(input, init);
};
const _origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  if (url && !url.startsWith('/api/proxy') && (url.startsWith('http') || url.startsWith('//'))) {
    url = _proxyBase + encodeURIComponent(url.startsWith('//') ? 'https:' + url : url);
  }
  return _origOpen.call(this, method, url, ...rest);
};
</script>`;

      html = html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(fetchRes.status >= 200 && fetchRes.status <= 599 ? fetchRes.status : 200).send(html);
    } else {
      // Binary/other content — stream as-is
      const buf = Buffer.from(await fetchRes.arrayBuffer());
      res.status(fetchRes.status >= 200 && fetchRes.status <= 599 ? fetchRes.status : 200).send(buf);
    }
  } catch (err) {
    res.status(500).json({ error: "Proxy error", detail: err.message });
  }
}

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
    responseLimit: false,
  },
};
