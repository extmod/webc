export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // Support both ?url= and combined query (Google appends &q=... etc)
  let rawUrl = req.query.url || "";
  if (!rawUrl) { res.status(400).json({ error: "Missing url" }); return; }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    // If extra query params were appended after url=..., rebuild them
    const extra = { ...req.query };
    delete extra.url;
    if (Object.keys(extra).length > 0) {
      const u = new URL(targetUrl);
      for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
      targetUrl = u.toString();
    }
    new URL(targetUrl); // validate
  } catch {
    res.status(400).json({ error: "Invalid URL" }); return;
  }

  try {
    const targetOrigin = new URL(targetUrl).origin;

    // Read body for POST
    let body = undefined;
    if (!["GET","HEAD"].includes(req.method)) {
      body = await new Promise((resolve) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });
    }

    const fetchRes = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Referer": targetOrigin,
        ...(body ? { "Content-Type": req.headers["content-type"] || "application/x-www-form-urlencoded" } : {}),
      },
      body,
      redirect: "manual",
    });

    // Handle redirects lewat proxy
    if ([301,302,303,307,308].includes(fetchRes.status)) {
      let loc = fetchRes.headers.get("location") || "";
      if (loc) {
        if (loc.startsWith("//")) loc = "https:" + loc;
        else if (loc.startsWith("/")) loc = targetOrigin + loc;
        else if (!loc.startsWith("http")) loc = new URL(loc, targetUrl).href;
        res.setHeader("Location", `/api/proxy?url=${encodeURIComponent(loc)}`);
        res.status(302).end();
        return;
      }
    }

    const ct = fetchRes.headers.get("content-type") || "";
    const isHtml = ct.includes("text/html");

    const skip = new Set([
      "content-encoding","transfer-encoding","connection","keep-alive",
      "upgrade","x-frame-options","content-security-policy",
      "content-security-policy-report-only","strict-transport-security","location",
    ]);
    fetchRes.headers.forEach((v, k) => {
      if (!skip.has(k.toLowerCase())) try { res.setHeader(k, v); } catch {}
    });

    const status = (fetchRes.status >= 200 && fetchRes.status <= 599) ? fetchRes.status : 200;

    if (isHtml) {
      let html = await fetchRes.text();
      const orig = targetUrl;
      const base = targetOrigin;

      function px(u) {
        if (!u) return u;
        if (/^(data:|javascript:|#|mailto:|tel:)/.test(u)) return u;
        if (u.startsWith("//")) u = "https:" + u;
        else if (u.startsWith("/")) u = base + u;
        else if (!u.startsWith("http")) { try { u = new URL(u, orig).href; } catch { return u; } }
        return `/api/proxy?url=${encodeURIComponent(u)}`;
      }

      html = html.replace(/(\b(?:href|src|action)\s*=\s*)(['"])(.*?)\2/gi, (_, a, q, v) => `${a}${q}${px(v)}${q}`);
      html = html.replace(/\s*integrity\s*=\s*["'][^"']*["']/gi, "");
      html = html.replace(/\s*crossorigin\s*=\s*["'][^"']*["']/gi, "");
      html = html.replace(/<base[^>]*>/gi, "");

      const script = `<script>
(function(){
var P='/api/proxy?url=',B='${base}',O='${orig}';
function px(u){
  if(!u||/^(data:|javascript:|#|mailto:|tel:)/.test(u)||u.startsWith(P))return u;
  if(u.startsWith('//'))u='https:'+u;
  else if(u.startsWith('/'))u=B+u;
  else if(!u.startsWith('http'))try{u=new URL(u,O).href}catch(e){return u}
  return P+encodeURIComponent(u);
}
// Intercept fetch
var oF=window.fetch;
window.fetch=function(inp,ini){
  var u=typeof inp==='string'?inp:(inp&&inp.url);
  if(u&&!u.startsWith(P)&&(u.startsWith('http')||u.startsWith('//')))return oF(px(u),ini);
  return oF(inp,ini);
};
// Intercept XHR
var oO=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  if(u&&!u.startsWith(P)&&(u.startsWith('http')||u.startsWith('//')))u=px(u);
  return oO.apply(this,[m,u].concat(Array.prototype.slice.call(arguments,2)));
};
// Intercept form submit
document.addEventListener('submit',function(e){
  var f=e.target,action=f.action||'';
  if(!action||action.startsWith(P))return;
  e.preventDefault();
  var params=new URLSearchParams(new FormData(f)).toString();
  var sep=action.includes('?')?'&':'?';
  var full=action+(params?sep+params:'');
  var proxied=P+encodeURIComponent(full);
  try{parent.postMessage({t:'nav',u:full},'*')}catch(ex){}
  window.location.href=proxied;
},true);
// Tell parent current URL
window.addEventListener('load',function(){try{parent.postMessage({t:'nav',u:O},'*')}catch(e){}});
})();
<\/script>`;

      html = html.replace(/<head([^>]*)>/i, `<head$1>${script}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(status).send(html);
    } else {
      const buf = Buffer.from(await fetchRes.arrayBuffer());
      res.status(status).send(buf);
    }
  } catch (err) {
    res.status(500).json({ error: "Proxy error", detail: err.message });
  }
}

export const config = {
  api: { bodyParser: false, externalResolver: true, responseLimit: false },
};
