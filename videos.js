// טעינת רשימת הסרטונים מהפלייליסט ביוטיוב.
import { CONFIG } from "./config.js";

const CACHE = "hasera.videos.v1";
const TTL = 6 * 3600 * 1000;

function isoDur(s) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || "");
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
export function guessYear(...texts) {
  for (const t of texts) {
    const m = /(19[5-9]\d|20[0-2]\d)/.exec(t || "");
    if (m) return +m[1];
  }
  return null;
}

async function fromDataApi(key) {
  const items = [];
  let page = "";
  do {
    const u = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,status&maxResults=50&playlistId=${CONFIG.playlistId}&key=${key}${page ? "&pageToken=" + page : ""}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error("playlistItems " + r.status);
    const j = await r.json();
    items.push(...j.items);
    page = j.nextPageToken;
  } while (page);
  const vids = items
    .filter((i) => i.status?.privacyStatus !== "private" && i.snippet.title !== "Deleted video" && i.snippet.title !== "Private video")
    .map((i, n) => ({
      id: i.snippet.resourceId.videoId,
      title: i.snippet.title,
      desc: i.snippet.description || "",
      order: n,
      secs: 0,
    }));
  for (let k = 0; k < vids.length; k += 50) {
    const ids = vids.slice(k, k + 50).map((v) => v.id).join(",");
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${key}`);
    if (!r.ok) break;
    const j = await r.json();
    const d = Object.fromEntries(j.items.map((x) => [x.id, isoDur(x.contentDetails.duration)]));
    vids.forEach((v) => { if (d[v.id] != null) v.secs = d[v.id]; });
  }
  return vids;
}

// גיבוי בלי מפתח: נגן יוטיוב נסתר נותן את רשימת המזהים, ו-noembed נותן שמות.
function fromIframe() {
  return new Promise((resolve, reject) => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:0";
    const inner = document.createElement("div");
    host.appendChild(inner);
    document.body.appendChild(host);
    const timeout = setTimeout(() => reject(new Error("iframe timeout")), 15000);
    window.ytReady.then((YT) => {
      const p = new YT.Player(inner, {
        playerVars: { listType: "playlist", list: CONFIG.playlistId },
        events: {
          onReady: async () => {
            let ids = p.getPlaylist() || [];
            for (let i = 0; i < 20 && !ids.length; i++) { await new Promise((r) => setTimeout(r, 300)); ids = p.getPlaylist() || []; }
            clearTimeout(timeout);
            p.destroy(); host.remove();
            const vids = await Promise.all(ids.map(async (id, n) => {
              let title = "סרטון " + (n + 1);
              try {
                const r = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`);
                const j = await r.json(); if (j.title) title = j.title;
              } catch {}
              return { id, title, desc: "", order: n, secs: 0 };
            }));
            resolve(vids);
          },
        },
      });
    });
  });
}

export const DEMO_VIDEOS = [
  { id: "demo1", title: "חנוכה אצל סבתא 1993", desc: "הדלקת נרות בסלון של סבתא, סופגניות, וכל הנכדים שרים מעוז צור.", secs: 1450 },
  { id: "demo2", title: "טיול לכנרת", desc: "יומיים בחוף צמח. האוהל קורס בלילה הראשון. קיץ 1995.", secs: 2462 },
  { id: "demo3", title: "יום הולדת 5 ליעקב", desc: "מסיבה בגן הציבורי, 1991. עוגת רכבת, קוסם ובלונים שעפו.", secs: 1125 },
  { id: "demo4", title: "פסח 1994", desc: "ליל הסדר הגדול. אבא קורא את ההגדה, הילדים מחפשים אפיקומן.", secs: 3150 },
  { id: "demo5", title: "הצגה בבית הספר", desc: "יעקב בתפקיד העץ.", secs: 740 },
].map((v, n) => ({ ...v, order: n, demo: true }));

export async function loadVideos({ force = false } = {}) {
  if (!CONFIG.firebase && !CONFIG.youtubeApiKey) {
    return DEMO_VIDEOS; // מצב הדגמה
  }
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE));
      if (c && Date.now() - c.at < TTL && c.list?.length) return c.list;
    } catch {}
  }
  let list = null;
  const key = CONFIG.youtubeApiKey || CONFIG.firebase?.apiKey;
  try { list = await fromDataApi(key); } catch (e) { console.warn("YouTube Data API failed, fallback", e); }
  if (!list?.length) { try { list = await fromIframe(); } catch (e) { console.warn(e); } }
  if (!list?.length) {
    try { const c = JSON.parse(localStorage.getItem(CACHE)); if (c?.list?.length) return c.list; } catch {}
    return [];
  }
  try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), list })); } catch {}
  return list;
}
