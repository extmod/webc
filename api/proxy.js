export default async function handler(req, res) {
  // Allow CORS untuk request dari Android app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Target-URL');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Ambil URL target dari query param atau body
  let targetUrl = req.query.url || (req.body && req.body.url);

  if (!targetUrl) {
    return res.status(400).json({ error: 'Parameter url diperlukan' });
  }

  // Pastikan ada protokol
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 9; Mobile) AppleWebKit/537.36 Chrome/91.0.4472.120 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
    });

    const contentType = response.headers.get('content-type') || 'text/html';
    const body = await response.text();

    // Rewrite URL absolut dalam HTML agar asset juga lewat proxy
    const baseUrl = new URL(targetUrl);
    const origin = baseUrl.origin;
    const proxyBase = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/proxy?url=`;

    let rewritten = body
      // href="https://... dan src="https://...
      .replace(/(href|src|action)="(https?:\/\/[^"]+)"/g, (_, attr, url) => {
        return `${attr}="${proxyBase}${encodeURIComponent(url)}"`;
      })
      // href="/path" → proxy ke origin yang sama
      .replace(/(href|src|action)="(\/[^"]+)"/g, (_, attr, path) => {
        return `${attr}="${proxyBase}${encodeURIComponent(origin + path)}"`;
      });

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Proxied-From', targetUrl);
    return res.status(response.status).send(rewritten);

  } catch (err) {
    return res.status(500).json({
      error: 'Gagal fetch URL',
      detail: err.message
    });
  }
}
