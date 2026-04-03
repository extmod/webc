export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  let rawUrl = req.query.url || "";

  // Kalau tidak ada url param, cek referer — mungkin navigasi relatif dari dalam proxy
  if (!rawUrl) {
    const referer = req.headers.referer || req.headers.referrer || "";
    if (referer.includes("/api/proxy?url=")) {
      try {
        const refBase = decodeURIComponent(referer.split("/api/proxy?url=")[1].split("&")[0]);
        const refOrigin = new URL(refBase).origin;
        // Rebuild URL dari path + query saat ini
        const fullPath = req.url.replace(/^\/api\/proxy/, "");
        rawUrl = encodeURIComponent(refOrigin + fullPath);
      } catch {}
    }
    if (!rawUrl) { res.status(400).json({ error: "Missing url" }); return; }
  }

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

      const esc = (s) => s.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$/g,'\\$');
      const safeOrig = esc(orig);
      const safeBase = esc(base);

      const script = `<script>
(function(){
var P='/api/proxy?url=';
var O='${safeOrig}';
var B='${safeBase}';

function px(u){
  if(!u||/^(data:|javascript:|#|mailto:|tel:|blob:)/.test(u))return u;
  if(u.startsWith(P))return u;
  try{
    if(u.startsWith('//'))u='https:'+u;
    else if(u.startsWith('/'))u=B+u;
    else if(!u.startsWith('http'))u=new URL(u,O).href;
    return P+encodeURIComponent(u);
  }catch(e){return u;}
}

function notify(u){
  if(!u||u.startsWith(P))return;
  try{parent.postMessage({t:'nav',u:u},'*');}catch(e){}
}

// Override location.assign, replace, href setter
try{
  var origAssign=window.location.assign.bind(window.location);
  var origReplace=window.location.replace.bind(window.location);
  Object.defineProperty(window,'location',{
    get:function(){return window._loc||location;},
    configurable:true
  });
  window.location.assign=function(u){
    var abs=px(u);notify(u.startsWith('http')?u:new URL(u,O).href);
    origAssign(abs);
  };
  window.location.replace=function(u){
    var abs=px(u);notify(u.startsWith('http')?u:new URL(u,O).href);
    origReplace(abs);
  };
}catch(e){}

var oF=window.fetch;
window.fetch=function(inp,ini){
  var u=typeof inp==='string'?inp:(inp&&inp.url||'');
  if(u&&!u.startsWith(P)&&(u.startsWith('http')||u.startsWith('//')))
    return oF(px(u),ini);
  return oF(inp,ini);
};

var oO=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  if(u&&!u.startsWith(P)&&(u.startsWith('http')||u.startsWith('//')))u=px(u);
  return oO.apply(this,[m,u].concat(Array.prototype.slice.call(arguments,2)));
};

try{
  var oPS=history.pushState.bind(history);
  var oRS=history.replaceState.bind(history);
  history.pushState=function(s,t,u){
    if(u){try{
      var abs=u.startsWith('http')?u:new URL(u,O).href;
      notify(abs);
      return oPS(s,t,P+encodeURIComponent(abs));
    }catch(e){}}
    return oPS(s,t,u);
  };
  history.replaceState=function(s,t,u){
    if(u){try{
      var abs=u.startsWith('http')?u:new URL(u,O).href;
      notify(abs);
      return oRS(s,t,P+encodeURIComponent(abs));
    }catch(e){}}
    return oRS(s,t,u);
  };
}catch(e){}

document.addEventListener('click',function(e){
  var el=e.target;
  while(el&&el.tagName!=='A')el=el.parentElement;
  if(!el)return;
  var href=el.getAttribute('href');
  if(!href||/^(javascript:|#|mailto:|tel:)/.test(href))return;
  e.preventDefault();e.stopPropagation();
  var abs;
  try{
    if(href.startsWith('//'))abs='https:'+href;
    else if(href.startsWith('/'))abs=B+href;
    else if(href.startsWith('http'))abs=href;
    else abs=new URL(href,O).href;
  }catch(ex){return;}
  notify(abs);
  window.location.href=P+encodeURIComponent(abs);
},true);

document.addEventListener('submit',function(e){
  var f=e.target;
  var action=f.action||O;
  if(action.startsWith(P))return;
  e.preventDefault();e.stopPropagation();
  var params=new URLSearchParams(new FormData(f)).toString();
  var abs;
  try{
    if(action.startsWith('//'))abs='https:'+action;
    else if(action.startsWith('/'))abs=B+action;
    else if(action.startsWith('http'))abs=action;
    else abs=new URL(action,O).href;
  }catch(ex){abs=O;}
  if(params){var sep=abs.includes('?')?'&':'?';abs=abs+sep+params;}
  notify(abs);
  window.location.href=P+encodeURIComponent(abs);
},true);

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