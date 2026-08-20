const API = "http://localhost:3000";
const vttCache = new Map();

console.log("LectureAI Core v7 background started");

async function post(path, body) {
  const response = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || `${path} HTTP ${response.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_VTT") {
    const url = message.url;
    if (!url) return sendResponse({ok:false,error:"没有 VTT URL"});
    if (vttCache.has(url)) return sendResponse({ok:true,vtt:vttCache.get(url)});
    fetch(url).then(r => {
      if (!r.ok) throw new Error(`VTT HTTP ${r.status}`);
      return r.text();
    }).then(vtt => {
      vttCache.set(url,vtt);
      sendResponse({ok:true,vtt});
    }).catch(e => sendResponse({ok:false,error:e.message}));
    return true;
  }

  const routes = {
    TRANSLATE: "/api/translate",
    CONTEXT: "/api/context",
    SUMMARY: "/api/summary",
    TERMS: "/api/terms",
    QUIZ: "/api/quiz",
    REVISION: "/api/revision"
  };
  const path = routes[message.type];
  if (!path) return;

  post(path, message)
    .then(data => sendResponse({ok:true, ...data}))
    .catch(error => sendResponse({ok:false,error:error.message}));
  return true;
});
