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
    const targetOrigin = new URL(targetUrl).origin;

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
        if (/^(data:|javascript:|#|mailto:|tel:|blob:)/.test(u)) return u;
        if (u.startsWith("/api/proxy")) return u;
        try {
          if (u.startsWith("//")) u = "https:" + u;
          else if (u.startsWith("/")) u = base + u;
          else if (!u.startsWith("http")) u = new URL(u, orig).href;
          return `/api/proxy?url=${encodeURIComponent(u)}`;
        } catch { return u; }
      }

      html = html.replace(/(\b(?:href|src|action)\s*=\s*)(['"])(.*?)\2/gi,
        (_, a, q, v) => `${a}${q}${px(v)}${q}`);
      html = html.replace(/\bsrcset\s*=\s*(['"])(.*?)\1/gi, (_, q, val) => {
        const rewritten = val.replace(/(\S+)(\s*(?:\s+\d+[wx])?)/g, (m, u, rest) => px(u) + rest);
        return `srcset=${q}${rewritten}${q}`;
      });
      html = html.replace(/\s*integrity\s*=\s*["'][^"']*["']/gi, "");
      html = html.replace(/\s*crossorigin\s*=\s*["'][^"']*["']/gi, "");
      html = html.replace(/<base[^>]*>/gi, "");

      // Escape untuk JSON string
      const safeOrig = JSON.stringify(orig);
      const safeBase = JSON.stringify(base);

      const script = `<script>
(function(){
var P='/api/proxy?url=';
var O=${safeOrig};
var B=${safeBase};

// Fungsi buat absolute URL
function abs(u){
  if(!u)return u;
  try{
    if(u.startsWith('//'))return 'https:'+u;
    if(u.startsWith('/'))return B+u;
    if(u.startsWith('http'))return u;
    return new URL(u,O).href;
  }catch(e){return u;}
}

// Fungsi proxy URL
function px(u){
  if(!u||/^(data:|javascript:|#|mailto:|tel:|blob:)/.test(u))return u;
  if(u.startsWith(P))return u;
  return P+encodeURIComponent(abs(u));
}

// Kirim navigasi ke parent (index.html)
function goto(u){
  try{parent.postMessage({t:'goto',u:u},'*');}catch(e){}
}
function notify(u){
  try{parent.postMessage({t:'nav',u:u},'*');}catch(e){}
}

// Intercept fetch
var oF=window.fetch;
window.fetch=function(inp,ini){
  var u=typeof inp==='string'?inp:(inp&&inp.url||'');
  if(u&&!u.startsWith(P)&&(u.startsWith('http')||u.startsWith('//')))
    return oF(P+encodeURIComponent(abs(u)),ini);
  return oF(inp,ini);
};

// Intercept XHR
var oO=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  if(u&&!u.startsWith(P)&&(u.startsWith('http')||u.startsWith('//')))
    u=P+encodeURIComponent(abs(u));
  return oO.apply(this,[m,u].concat(Array.prototype.slice.call(arguments,2)));
};

// Intercept semua klik link — ini yang paling penting
document.addEventListener('click',function(e){
  var el=e.target;
  while(el&&el.tagName!=='A')el=el.parentElement;
  if(!el)return;
  var href=el.getAttribute('href');
  if(!href||/^(javascript:|mailto:|tel:)/.test(href))return;
  if(href==='#'||href.startsWith('#'))return;
  e.preventDefault();
  e.stopPropagation();
  var a=abs(href);
  goto(a); // minta parent load URL baru
},true);

// Intercept form submit
document.addEventListener('submit',function(e){
  var f=e.target;
  var action=f.action||O;
  e.preventDefault();
  e.stopPropagation();
  var params=new URLSearchParams(new FormData(f)).toString();
  var a=abs(action);
  if(params){var sep=a.includes('?')?'&':'?';a+=sep+params;}
  goto(a);
},true);

// Intercept pushState / replaceState (Google Search pakai ini)
try{
  var oPS=history.pushState.bind(history);
  var oRS=history.replaceState.bind(history);
  history.pushState=function(s,t,u){
    var result=oPS(s,t,u);
    if(u)notify(abs(u));
    return result;
  };
  history.replaceState=function(s,t,u){
    var result=oRS(s,t,u);
    if(u)notify(abs(u));
    return result;
  };
}catch(e){}

// Intercept window.location.href = "..." lewat MutationObserver pada navigasi
// Serta intercept assign/replace
(function(){
  var nav=window.navigator;
  // Wrap location setter
  try{
    var desc=Object.getOwnPropertyDescriptor(window,'location');
    if(!desc||desc.configurable){
      var _href=location.href;
      setInterval(function(){
        var cur=location.href;
        if(cur!==_href){
          _href=cur;
          // Cek apakah URL sudah lewat proxy
          if(!cur.startsWith(P)&&cur.startsWith('http')){
            notify(cur);
          }
        }
      },300);
    }
  }catch(e){}
})();

notify(O);
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
