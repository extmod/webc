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

    // ── Follow redirect manual ────────────────────────────────────────────
    let fetchRes;
    let currentUrl = targetUrl;
    let currentMethod = req.method;
    let currentBody = body;

    for (let i = 0; i <= 8; i++) {
      const parsedCurrent = new URL(currentUrl);
      fetchRes = await fetch(currentUrl, {
        method: currentMethod,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "identity",
          "Referer": parsedCurrent.origin,
          "Origin": parsedCurrent.origin,
          ...(currentBody ? { "Content-Type": req.headers["content-type"] || "application/x-www-form-urlencoded" } : {}),
        },
        body: currentBody,
        redirect: "manual",
      });

      if ([301, 302, 303, 307, 308].includes(fetchRes.status)) {
        let loc = fetchRes.headers.get("location") || "";
        if (!loc) break;
        if (loc.startsWith("//")) loc = "https:" + loc;
        else if (loc.startsWith("/")) loc = parsedCurrent.origin + loc;
        else if (!loc.startsWith("http")) loc = new URL(loc, currentUrl).href;
        if (fetchRes.status === 303) { currentMethod = "GET"; currentBody = undefined; }
        currentUrl = loc;
        continue;
      }
      break;
    }

    const parsedFinal = new URL(currentUrl);
    const finalOrigin = parsedFinal.origin;
    const finalBase = currentUrl.endsWith("/")
      ? currentUrl
      : currentUrl.substring(0, currentUrl.lastIndexOf("/") + 1);

    const ct = fetchRes.headers.get("content-type") || "";
    const isHtml = ct.includes("text/html");
    const isCss = ct.includes("text/css");
    const isJs = ct.includes("javascript");

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

    // ── px(): rewrite URL ke proxy ────────────────────────────────────────
    function px(u) {
      if (!u || typeof u !== "string") return u;
      u = u.trim();
      if (/^(data:|javascript:|#|mailto:|tel:|blob:|about:)/.test(u)) return u;
      if (u.startsWith(PROXY_BASE) || u.includes("/api/proxy?url=")) return u;
      try {
        if (u.startsWith("//")) u = "https:" + u;
        else if (u.startsWith("/")) u = finalOrigin + u;
        else if (!u.startsWith("http")) u = new URL(u, finalBase).href;
        return `${PROXY_BASE}${encodeURIComponent(u)}`;
      } catch { return u; }
    }

    function rewriteCss(css) {
      return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, q, u) => `url(${q}${px(u)}${q})`);
    }

    // ── Rewrite JS: tangkap assignment ke window.location ─────────────────
    function rewriteJs(js) {
      // window.location.href = "..." atau location.href = "..."
      js = js.replace(
        /((?:window\.)?location(?:\.href)?\s*=\s*)(['"`])(https?:\/\/[^'"`]+)\2/g,
        (_, pre, q, u) => `${pre}${q}${px(u)}${q}`
      );
      return js;
    }

    if (isHtml) {
      let html = await fetchRes.text();

      // 1. Atribut href, src, action, data-*, poster
      html = html.replace(
        /(\b(?:href|src|action|data-src|data-href|data-lazy|data-original|data-url|data-video-url|poster|data-hls-url|data-mp4-url)\s*=\s*)(['"])(.*?)\2/gi,
        (_, attr, q, v) => `${attr}${q}${px(v)}${q}`
      );

      // 2. srcset
      html = html.replace(/\bsrcset\s*=\s*(['"])(.*?)\1/gi, (_, q, val) => {
        const rw = val.replace(/([^\s,][^\s,]*?)(\s+\d+[wx])?(?=\s*,|\s*$)/g, (m, u, d) => px(u) + (d || ""));
        return `srcset=${q}${rw}${q}`;
      });

      // 3. <style>
      html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, o, css, c) => o + rewriteCss(css) + c);

      // 4. inline style
      html = html.replace(/\bstyle\s*=\s*(['"])(.*?)\1/gi, (_, q, css) => `style=${q}${rewriteCss(css)}${q}`);

      // 5. meta refresh
      html = html.replace(
        /(<meta[^>]+content\s*=\s*["']\d+;\s*url=)([^"'>]+)(["'])/gi,
        (_, pre, u, q) => `${pre}${px(u)}${q}`
      );

      // 6. Rewrite JS inline (location assignments)
      html = html.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, o, js, c) => {
        if (o.includes("src=")) return _ ; // skip external scripts, handled via src rewrite
        return o + rewriteJs(js) + c;
      });

      // 7. Bersihkan
      html = html.replace(/\s*integrity\s*=\s*["'][^"']*["']/gi, "");
      html = html.replace(/\s*crossorigin\s*=\s*["'][^"']*["']/gi, "");
      html = html.replace(/<base[^>]*>/gi, "");

      // 8. Inject interceptor script
      const safeOrig   = JSON.stringify(currentUrl);
      const safeBase   = JSON.stringify(finalBase);
      const safeOrigin = JSON.stringify(finalOrigin);
      const safeProxy  = JSON.stringify(PROXY_BASE);

      const script = `<script>
(function(){
var PROXY=${safeProxy};
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

function goto(u){try{parent.postMessage({t:'goto',u:u},'*');}catch(e){}}
function notify(u){try{parent.postMessage({t:'nav',u:u},'*');}catch(e){}}

// Intercept fetch
var oFetch=window.fetch;
window.fetch=function(inp,ini){
  var u=typeof inp==='string'?inp:(inp&&inp.url||String(inp));
  if(u&&!u.includes('/api/proxy?url=')&&(u.startsWith('http')||u.startsWith('//')||u.startsWith('/'))){
    var p=PROXY+encodeURIComponent(abs(u));
    return oFetch(typeof inp==='string'?p:new Request(p,inp),ini);
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
    var p=new URLSearchParams(new FormData(f)).toString();
    if(p){a+=a.includes('?')?'&'+p:'?'+p;}
    goto(a);
  }else{
    try{parent.postMessage({t:'post',u:a,d:new URLSearchParams(new FormData(f)).toString()},'*');}catch(ex){}
  }
},true);

// Intercept window.location assignments
try{
  var locProto=window.Location.prototype;
  var origAssign=locProto.assign;
  var origReplace=locProto.replace;
  locProto.assign=function(u){goto(abs(u));};
  locProto.replace=function(u){goto(abs(u));};
}catch(e){}

// Intercept pushState/replaceState
try{
  var oPS=history.pushState.bind(history);
  var oRS=history.replaceState.bind(history);
  history.pushState=function(s,t,u){if(u){notify(abs(String(u)));} return oPS(s,t,u);};
  history.replaceState=function(s,t,u){if(u){notify(abs(String(u)));} return oRS(s,t,u);};
}catch(e){}

// Monitor location changes (SPA / JS redirect)
var _last=location.href;
setInterval(function(){
  var cur=location.href;
  if(cur!==_last){
    _last=cur;
    if(!cur.includes('/api/proxy?url=')&&(cur.startsWith('http')||cur.startsWith('/')))
      goto(abs(cur));
  }
},300);

notify(ORIG);
})();
<\/script>`;

      html = html.replace(/<head([^>]*)>/i, `<head$1>${script}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(status).send(html);

    } else if (isCss) {
      const css = await fetchRes.text();
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      res.status(status).send(rewriteCss(css));

    } else if (isJs) {
      const js = await fetchRes.text();
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.status(status).send(rewriteJs(js));

    } else {
      // Binary: gambar, video, font, dll — stream langsung
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
