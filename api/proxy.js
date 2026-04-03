export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Target-URL');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let targetUrl = req.query.url || (req.body && req.body.url);

  if (!targetUrl) {
    return res.status(400).json({ error: 'Parameter url diperlukan' });
  }

  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 9; Mobile) AppleWebKit/537.36 Chrome/91.0.4472.120 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
    });

    const contentType = response.headers.get('content-type') || 'text/html';

    // Pakai URL final setelah redirect sebagai base
    const finalUrl = response.url || targetUrl;
    const baseUrl = new URL(finalUrl);
    const origin = baseUrl.origin;

    const host = req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const proxyBase = `${proto}://${host}/api/proxy?url=`;

    function rewriteUrl(u) {
      try {
        // Protocol-relative: //domain.com/path
        if (u.startsWith('//')) {
          return proxyBase + encodeURIComponent('https:' + u);
        }
        // Absolute URL
        if (u.startsWith('http://') || u.startsWith('https://')) {
          return proxyBase + encodeURIComponent(u);
        }
        // Relative /path
        if (u.startsWith('/')) {
          return proxyBase + encodeURIComponent(origin + u);
        }
        // Relative tanpa slash
        const basePath = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
        return proxyBase + encodeURIComponent(basePath + u);
      } catch (e) {
        return u;
      }
    }

    const body = await response.text();

    let rewritten = body
      // Protocol-relative double quote
      .replace(/(href|src|action)="(\/\/[^"]+)"/g, (_, attr, u) => {
        return `${attr}="${rewriteUrl(u)}"`;
      })
      // Protocol-relative single quote
      .replace(/(href|src|action)='(\/\/[^']+)'/g, (_, attr, u) => {
        return `${attr}='${rewriteUrl(u)}'`;
      })
      // Absolute double quote
      .replace(/(href|src|action)="(https?:\/\/[^"]+)"/g, (_, attr, u) => {
        return `${attr}="${rewriteUrl(u)}"`;
      })
      // Absolute single quote
      .replace(/(href|src|action)='(https?:\/\/[^']+)'/g, (_, attr, u) => {
        return `${attr}='${rewriteUrl(u)}'`;
      })
      // Relative /path double quote
      .replace(/(href|src|action)="(\/[^"]*)"/g, (_, attr, u) => {
        return `${attr}="${rewriteUrl(u)}"`;
      })
      // Relative /path single quote
      .replace(/(href|src|action)='(\/[^']*)'/g, (_, attr, u) => {
        return `${attr}='${rewriteUrl(u)}'`;
      });

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Proxied-From', finalUrl);
    return res.status(response.status).send(rewritten);

  } catch (err) {
    return res.status(500).json({
      error: 'Gagal fetch URL',
      detail: err.message
    });
  }
}
