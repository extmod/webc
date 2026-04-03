export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  let rawUrl = req.query.url || "";
  if (!rawUrl) { res.status(400).json({ error: "Missing url" }); return; }

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid URL" }); return;
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const targetOrigin = parsedTarget.origin;
    // base adalah direktori dari URL aktif — penting untuk relative URL tanpa slash
    const targetBase = targetUrl.endsWith("/")
      ? targetUrl
      : targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

    // HOST absolut Vercel — agar redirect tidak nyasar ke domain situs tujuan
    const HOST = `https://${req.headers.host}`;
    const PROXY_BASE = `${HOST}/api/proxy?url=`;

    let body = undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      body = await new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
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

    // Handle redirect
    if ([301, 302, 303, 307, 308].includes(fetchRes.status)) {
      let loc = fetchRes.headers.get("location") || "";
      if (loc) {
        if (loc.startsWith("//")) loc = "https:" + loc;
        else if (loc.startsWith("/")) loc = targetOrigin + loc;
        else if (!loc.startsWith("http")) loc = new URL(loc, targetUrl).href;
        res.setHeader("Location", `${PROXY_BASE}${encodeURIComponent(loc)}`);
        res.status(302).end();
        return;
      }
    }

    const ct = fetchRes.headers.get("content-type") || "";
    const isHtml = ct.includes("text/html");
    const isCss = ct.includes("text/css");

    // Skip headers yang bermasalah
    const skipHeaders = new Set([
      "content-encoding", "transfer-encoding", "connection", "keep-alive",
      "upgrade", "x-frame-options", "content-security-policy",
      "content-security-policy-report-only", "strict-transport-security",
      "location", "set-cookie",
    ]);
    fetchRes.headers.forEach((v, k) => {
      if (!skipHeaders.has(k.toLowerCase())) try { res.setHeader(k, v); } catch {}
    });

    const status = (fetchRes.status >= 200 && fetchRes.status <= 599) ? fetchRes.status : 200;

    // ─── Fungsi rewrite URL ────────────────────────────────────────────────
    function px(u) {
      if (!u || typeof u !== "string") return u;
      u = u.trim();
      if (/^(data:|javascript:|#|mailto:|tel:|blob:|about:)/.test(u)) return u;
      if (u.startsWith(PROXY_BASE) || u.includes("/api/proxy?url=")) return u;
      try {
        if (u.startsWith("//")) u = "https:" + u;
        else if (u.startsWith("/")) u = targetOrigin + u;
        else if (!u.startsWith("http")) u = new URL(u, targetBase).href;
        return `${PROXY_BASE}${encodeURIComponent(u)}`;
      } catch {
        return u;
      }
    }

    // ─── Rewrite CSS content ───────────────────────────────────────────────
    function rewriteCss(css) {
      // url('...') dan url("...") dan url(...)
      return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, q, u) => {
        const rewritten = px(u);
        return `url(${q}${rewritten}${q})`;
      });
    }

    // ─── Proses HTML ───────────────────────────────────────────────────────
    if (isHtml) {
      let html = await fetchRes.text();

      // 1. Rewrite atribut href, src, action, data-src, data-href, poster
      html = html.replace(
        /(\b(?:href|src|action|data-src|data-href|data-lazy|data-original|data-url|poster)\s*=\s*)(['"])(.*?)\2/gi,
        (_, attr, q, v) => `${attr}${q}${px(v)}${q}`
      );

      // 2. Rewrite srcset
      html = html.replace(/\bsrcset\s*=\s*(['"])(.*?)\1/gi, (_, q, val) => {
        const rewritten = val.replace(/([^\s,][^\s,]*?)(\s+\d+[wx])?(?=\s*,|\s*$)/g, (m, u, desc) => {
          return px(u) + (desc || "");
        });
        return `srcset=${q}${rewritten}${q}`;
      });

      // 3. Rewrite CSS dalam tag <style>
      html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, css, close) => {
        return open + rewriteCss(css) + close;
      });

      // 4. Rewrite inline style attribute
      html = html.replace(/\bstyle\s*=\s*(['"])(.*?)\1/gi, (_, q, css) => {
        return `style=${q}${rewriteCss(css)}${q}`;
      });

      // 5. Rewrite meta refresh
      html = html.replace(
        /(<meta[^>]+content\s*=\s*["']\d+;\s*url=)([^"'>]+)(["'])/gi,
        (_, pre, u, q) => `${pre}${px(u)}${q}`
      );

      // 6. Hapus atribut yang bikin masalah
      html = html.replace(/\s*integrity\s*=\s*["'][^"']*["']/gi, "");
      html = html.replace(/\s*crossorigin\s*=\s*["'][^"']*["']/gi, "");
      html = html.replace(/<base[^>]*>/gi, "");

      // 7. Inject script interceptor
      const safeOrig = JSON.stringify(targetUrl);
      const safeBase = JSON.stringify(targetBase);
      const safeOrigin = JSON.stringify(targetOrigin);
      const safeProxyBase = JSON.stringify(PROXY_BASE);

      const script = `<script>
(function(){
var PROXY=${safeProxyBase};
var ORIG=${safeOrig};
var BASE=${safeBase};
var ORIGIN=${safeOrigin};

function abs(u){
  if(!u||typeof u!=='string')return u;
  u=u.trim();
  try{
    if(u.startsWith('//'))return 'https:'+u;
    if(u.startsWith('/'))return ORIGIN+u;
    if(u.startsWith('http'))return u;
    return new URL(u,BASE).href;
  }catch(e){return u;}
}

function px(u){
  if(!u||/^(data:|javascript:|#|mailto:|tel:|blob:|about:)/.test(u))return u;
  if(u.startsWith(PROXY)||u.includes('/api/proxy?url='))return u;
  return PROXY+encodeURIComponent(abs(u));
}

function goto(u){
  try{parent.postMessage({t:'goto',u:u},'*');}catch(e){}
}
function notify(u){
  try{parent.postMessage({t:'nav',u:u},'*');}catch(e){}
}

// Intercept fetch
var oFetch=window.fetch;
window.fetch=function(inp,ini){
  var u=typeof inp==='string'?inp:(inp&&inp.url||String(inp));
  if(u&&!u.includes('/api/proxy?url=')&&(u.startsWith('http')||u.startsWith('//')||u.startsWith('/'))){
    var proxied=PROXY+encodeURIComponent(abs(u));
    if(typeof inp==='string') return oFetch(proxied,ini);
    var newReq=new Request(proxied,inp);
    return oFetch(newReq,ini);
  }
  return oFetch(inp,ini);
};

// Intercept XHR
var oOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  if(u&&typeof u==='string'&&!u.includes('/api/proxy?url=')&&
    (u.startsWith('http')||u.startsWith('//')||u.startsWith('/'))){
    u=PROXY+encodeURIComponent(abs(u));
  }
  return oOpen.apply(this,[m,u].concat(Array.prototype.slice.call(arguments,2)));
};

// Intercept klik link
document.addEventListener('click',function(e){
  var el=e.target;
  while(el&&el.tagName!=='A')el=el.parentElement;
  if(!el)return;
  var href=el.getAttribute('href');
  if(!href||/^(javascript:|mailto:|tel:)/.test(href))return;
  if(href==='#'||href.startsWith('#'))return;
  e.preventDefault();
  e.stopPropagation();
  goto(abs(href));
},true);

// Intercept form submit
document.addEventListener('submit',function(e){
  var f=e.target;
  var action=f.getAttribute('action')||ORIG;
  e.preventDefault();
  e.stopPropagation();
  var method=(f.method||'get').toUpperCase();
  var a=abs(action);
  if(method==='GET'){
    var params=new URLSearchParams(new FormData(f)).toString();
    if(params){var sep=a.includes('?')?'&':'?';a+=sep+params;}
    goto(a);
  } else {
    var formData=new URLSearchParams(new FormData(f)).toString();
    try{parent.postMessage({t:'post',u:a,d:formData},'*');}catch(ex){}
  }
},true);

// Intercept pushState / replaceState
try{
  var oPS=history.pushState.bind(history);
  var oRS=history.replaceState.bind(history);
  history.pushState=function(s,t,u){
    if(u){var a=abs(String(u));notify(a);return oPS(s,t,u);}
    return oPS(s,t,u);
  };
  history.replaceState=function(s,t,u){
    if(u){var a=abs(String(u));notify(a);return oRS(s,t,u);}
    return oRS(s,t,u);
  };
}catch(e){}

// Monitor location.href changes (SPA)
var _lastHref=location.href;
setInterval(function(){
  var cur=location.href;
  if(cur!==_lastHref){
    _lastHref=cur;
    if(!cur.includes('/api/proxy?url=')&&(cur.startsWith('http')||cur.startsWith('/'))){
      notify(abs(cur));
    }
  }
},500);

notify(ORIG);
})();
<\/script>`;

      html = html.replace(/<head([^>]*)>/i, `<head$1>${script}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(status).send(html);

    // ─── Proses CSS ──────────────────────────────────────────────────────
    } else if (isCss) {
      let css = await fetchRes.text();
      css = rewriteCss(css);
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      res.status(status).send(css);

    // ─── Binary / lainnya ────────────────────────────────────────────────
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
