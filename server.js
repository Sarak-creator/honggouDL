// Thin proxy so the Apify token never reaches the browser.
import dotenv from 'dotenv';
import express from 'express';
import convert from 'heic-convert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Readable } from 'node:stream';

dotenv.config();

function getToken() {
  try {
    dotenv.config({ override: true });
  } catch {}
  return process.env.APIFY_TOKEN;
}

const BASE = 'https://api.apify.com/v2';
const ACTORS = {
  search: 'spider_studio~hongguo-search',
  detail: 'spider_studio~hongguo-series-detail',
  download: 'spider_studio~hongguo-series-download-kvs',
  feed: 'spider_studio~hongguo-recommend-feed',
  dlVideo: 'spider_studio~hongguo-video-download-kvs',
};

async function apify(p, body) {
  const token = getToken();
  const r = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const raw = await r.text();
    let msg = raw;
    try {
      const data = JSON.parse(raw);
      if (data?.error?.message) {
        msg = data.error.message;
      }
    } catch {}
    if (r.status === 403 && (msg.includes('Monthly usage hard limit') || msg.includes('platform-feature-disabled'))) {
      throw new Error(`Apify 403: Monthly usage hard limit ($5.00) exceeded. Replace APIFY_TOKEN in .env with a new token from apify.com`);
    }
    throw new Error(`Apify ${r.status}: ${msg.slice(0, 300)}`);
  }
  return r.json();
}
const sync = (actor, input) =>
  apify(`/acts/${actor}/run-sync-get-dataset-items?timeout=300`, input);
const isId = (s) => /^\d{5,30}$/.test(String(s));
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const allowWithoutToken = [
    '/api/translate',
    '/api/apify-status',
    '/api/img',
    '/api/imgcheck',
    '/api/file',
    '/api/home',
  ];
  if (!getToken() && req.path.startsWith('/api') && !allowWithoutToken.some((p) => req.path.startsWith(p))) {
    return res.status(500).json({ error: 'APIFY_TOKEN is not set. Please add APIFY_TOKEN in .env or Vercel Environment Variables.' });
  }
  next();
});

// Google Translate proxy & in-memory cache
const translationCache = new Map();

async function translateText(text, targetLang = 'en', sourceLang = 'auto') {
  if (!text || typeof text !== 'string') return text;
  const clean = text.trim();
  if (!clean) return text;

  const tl = targetLang === 'zh' ? 'zh-CN' : targetLang;
  const sl = sourceLang === 'zh' ? 'zh-CN' : sourceLang;
  if (sl === tl) return clean;

  const cacheKey = `${sl}:${tl}:${clean}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(clean)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!r.ok) throw new Error(`Google Translate upstream ${r.status}`);
    const data = await r.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const translated = data[0].map((part) => part[0]).filter(Boolean).join('');
      if (translationCache.size > 5000) {
        const oldest = translationCache.keys().next().value;
        translationCache.delete(oldest);
      }
      translationCache.set(cacheKey, translated);
      return translated;
    }
    return clean;
  } catch (err) {
    console.warn(`Translation warning: ${err.message}`);
    return clean;
  }
}

async function translateBatchTexts(texts, targetLang = 'en', sourceLang = 'auto') {
  if (!Array.isArray(texts) || !texts.length) return [];
  const tl = targetLang === 'zh' ? 'zh-CN' : targetLang;
  const sl = sourceLang === 'zh' ? 'zh-CN' : sourceLang;
  if (sl === tl) return texts;

  const results = new Array(texts.length);
  const uncachedIndices = [];
  const uncachedTexts = [];

  texts.forEach((raw, i) => {
    const text = String(raw || '').trim().replace(/[\r\n]+/g, ' ');
    if (!text) {
      results[i] = '';
      return;
    }
    const key = `${sl}:${tl}:${text}`;
    if (translationCache.has(key)) {
      results[i] = translationCache.get(key);
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(text);
    }
  });

  if (!uncachedTexts.length) return results;

  const CHUNK_SIZE = 25;
  for (let c = 0; c < uncachedTexts.length; c += CHUNK_SIZE) {
    const chunkTexts = uncachedTexts.slice(c, c + CHUNK_SIZE);
    const chunkIndices = uncachedIndices.slice(c, c + CHUNK_SIZE);
    const joined = chunkTexts.join('\n');
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(joined)}`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (!r.ok) throw new Error(`Google Translate upstream ${r.status}`);
      const data = await r.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const full = data[0].map((part) => part[0]).filter(Boolean).join('');
        const split = full.split('\n');
        chunkIndices.forEach((origIdx, k) => {
          const translated = (split[k] || chunkTexts[k]).trim();
          results[origIdx] = translated;
          const key = `${sl}:${tl}:${chunkTexts[k]}`;
          if (translationCache.size > 5000) {
            const first = translationCache.keys().next().value;
            translationCache.delete(first);
          }
          translationCache.set(key, translated);
        });
      } else {
        chunkIndices.forEach((origIdx, k) => {
          results[origIdx] = chunkTexts[k];
        });
      }
    } catch (err) {
      console.warn('Batch translation chunk error:', err.message);
      chunkIndices.forEach((origIdx, k) => {
        results[origIdx] = chunkTexts[k];
      });
    }
  }

  return results;
}

app.post('/api/translate', wrap(async ({ body }) => {
  const target = String(body.targetLang || body.target || 'en');
  const source = String(body.sourceLang || body.source || 'auto');

  if (Array.isArray(body.texts)) {
    const slice = body.texts.slice(0, 100);
    const results = await translateBatchTexts(slice, target, source);
    return { translations: results, targetLang: target };
  }

  if (typeof body.text === 'string') {
    const result = await translateText(body.text, target, source);
    return { translation: result, targetLang: target };
  }

  throw new Error('Missing "text" or "texts" parameter in request body');
}));

// Cache directory: on Vercel use writable /tmp, locally use .cache
const CACHE_DIR = process.env.VERCEL ? path.join(os.tmpdir(), 'hongguo-cache') : path.resolve('.cache');
const BUNDLED_CACHE_FILE = path.resolve('.cache/home.json');
const CACHE_FILE = path.join(CACHE_DIR, 'home.json');

const readCache = () => {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
    if (fs.existsSync(BUNDLED_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(BUNDLED_CACHE_FILE, 'utf8'));
    }
  } catch {}
  return null;
};

const saveCache = (targetPath, data) => {
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, typeof data === 'string' ? data : JSON.stringify(data));
  } catch (err) {
    console.warn(`Cache save skipped (${err.message})`);
  }
};

app.get('/api/apify-status', async (req, res) => {
  const token = getToken();
  if (!token) {
    return res.json({ configured: false, error: 'APIFY_TOKEN is missing' });
  }
  try {
    const r = await fetch(BASE + '/users/me/limits', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) {
      return res.json({ configured: true, ok: false, status: r.status, error: await r.text() });
    }
    const { data } = await r.json();
    const maxUsd = data?.limits?.maxMonthlyUsageUsd ?? 5;
    const currentUsd = data?.current?.monthlyUsageUsd ?? 0;
    const limitExceeded = currentUsd >= maxUsd;
    const cache = readCache();
    res.json({
      configured: true,
      ok: !limitExceeded,
      limitExceeded,
      currentUsd: +currentUsd.toFixed(2),
      maxUsd,
      cycleEnd: data?.monthlyUsageCycle?.endAt,
      cachedCount: cache?.items?.length || 0
    });
  } catch (err) {
    res.json({ configured: true, ok: false, error: err.message });
  }
});

app.get('/api/home', wrap(async ({ query }) => {
  const n = Math.min(+query.limit || 200, 1000);
  const forceRefresh = query.refresh === 'true' || query.refresh === '1';
  const c = readCache();
  // Fresh cache hit within 24h if we already have enough items
  if (!forceRefresh && c && Array.isArray(c.items) && c.items.length >= n && Date.now() - c.t < 864e5) {
    return c.items.slice(0, n);
  }

  const token = getToken();
  if (!token) {
    if (c?.items?.length) return c.items.slice(0, n);
    throw new Error('APIFY_TOKEN is not set. Please add APIFY_TOKEN in .env or Vercel Environment Variables.');
  }

  try {
    const items = await sync(ACTORS.feed, { maxResults: n, includeRaw: true });
    const good = items.filter((i) => i.success !== false);
    if (good.length) {
      // Merge with existing items so drama library grows
      const existing = c?.items || [];
      const map = new Map();
      const getId = (it) => {
        const d = it.data || it;
        const v = d.video_data?.[0] || d;
        return String(v.series_id || v.seriesId || d.series_id || d.seriesId || it.seriesId || '');
      };
      existing.forEach((it) => { const id = getId(it); if (id) map.set(id, it); });
      good.forEach((it) => { const id = getId(it); if (id) map.set(id, it); });
      const merged = Array.from(map.values());
      saveCache(CACHE_FILE, { t: Date.now(), requested: merged.length, items: merged });
      return merged.slice(0, n);
    }
    return c?.items?.length ? c.items.slice(0, n) : items;
  } catch (err) {
    console.warn(`Feed fetch failed (${err.message}). Falling back to cached data.`);
    if (c?.items?.length) {
      return c.items.slice(0, n);
    }
    throw err;
  }
}));

app.post('/api/search', wrap(async ({ body }) => {
  const q = String(body.query || '').trim();
  if (!q) throw new Error('Empty query');
  const maxPages = Math.min(+body.maxPages || 3, 5);

  const c = readCache();
  const existing = c?.items || [];
  const qLower = q.toLowerCase();
  const getId = (it) => {
    const d = it.data || it;
    const v = d.video_data?.[0] || d;
    return String(v.series_id || v.seriesId || d.series_id || d.seriesId || it.seriesId || '');
  };

  const localMatches = existing.filter((item) => {
    const text = JSON.stringify(item).toLowerCase();
    return text.includes(qLower);
  });

  const token = getToken();
  if (!token) {
    if (localMatches.length) return localMatches;
    throw new Error('APIFY_TOKEN is not set. Please add APIFY_TOKEN in .env or Vercel Environment Variables.');
  }

  try {
    const results = await sync(ACTORS.search, { queries: [q], maxPages });
    const good = results.filter((i) => i.success !== false);
    if (good.length) {
      // Merge with cache so library grows
      const map = new Map();
      existing.forEach((it) => { const id = getId(it); if (id) map.set(id, it); });
      good.forEach((it) => { const id = getId(it); if (id) map.set(id, it); });
      const merged = Array.from(map.values());
      saveCache(CACHE_FILE, { t: c?.t || Date.now(), requested: merged.length, items: merged });

      // Combine live results + local matches for richer search results
      const resultMap = new Map();
      good.forEach((it) => { const id = getId(it); if (id) resultMap.set(id, it); });
      localMatches.forEach((it) => { const id = getId(it); if (id) resultMap.set(id, it); });
      return Array.from(resultMap.values());
    }

    if (localMatches.length) return localMatches;
    return results;
  } catch (err) {
    console.warn(`Search failed on Apify for "${q}" (${err.message}). Checking cache.`);
    if (localMatches.length) return localMatches;
    throw err;
  }
}));

// Series details cached on disk (free plan allows only 100 series IDs/month).
app.get('/api/series/:id', wrap(async ({ params }) => {
  if (!isId(params.id)) throw new Error('Invalid series id');
  const tmpSeriesFile = path.join(CACHE_DIR, `series-${params.id}.json`);
  const bundledSeriesFile = path.resolve(`.cache/series-${params.id}.json`);
  let cached = null;
  try {
    if (fs.existsSync(tmpSeriesFile)) {
      cached = JSON.parse(fs.readFileSync(tmpSeriesFile, 'utf8'));
    } else if (fs.existsSync(bundledSeriesFile)) {
      cached = JSON.parse(fs.readFileSync(bundledSeriesFile, 'utf8'));
    }
    const hasEpisodes = (cached?.items?.[0]?.episodes?.length || 0) > 1;
    if (hasEpisodes && Date.now() - cached.t < 7 * 864e5) return cached.items;
  } catch {}

  const token = getToken();
  if (!token) {
    if (cached?.items) return cached.items;
    const home = readCache();
    const hit = home?.items?.find((i) => {
      const d = i.data || i;
      const v = d.video_data?.[0] || d;
      const id = String(v.series_id || v.seriesId || d.series_id || d.seriesId || i.seriesId || '');
      return id === String(params.id);
    });
    if (hit) {
      const d = hit.data || hit;
      const v = d.video_data?.[0] || d;
      return [{
        success: true,
        series: {
          seriesId: params.id,
          title: v.series_name || hit.title,
          synopsis: v.series_intro || hit.intro,
          coverUrl: hit.coverUrl,
          episodeCount: hit.episodeCount || v.episode_cnt,
          playCount: hit.playCount,
          firstVideoId: hit.firstVideoId,
        },
        episodes: hit.firstVideoId ? [{ videoId: hit.firstVideoId, episodeIndex: '1' }] : [],
        isFallback: true,
      }];
    }
    throw new Error('APIFY_TOKEN is not configured in Vercel Environment Variables');
  }

  try {
    const items = await sync(ACTORS.detail, { seriesIds: [params.id] });
    if (items.some((i) => i.success !== false)) {
      saveCache(tmpSeriesFile, { t: Date.now(), items });
    }
    return items;
  } catch (err) {
    console.warn(`Series detail error for ${params.id} (${err.message}). Falling back to cache.`);
    if (cached?.items) return cached.items;

    // Check if we can build a fallback record from home cache
    const home = readCache();
    const hit = home?.items?.find((i) => {
      const d = i.data || i;
      const v = d.video_data?.[0] || d;
      const id = String(v.series_id || v.seriesId || d.series_id || d.seriesId || i.seriesId || '');
      return id === String(params.id);
    });
    if (hit) {
      const d = hit.data || hit;
      const v = d.video_data?.[0] || d;
      return [{
        success: true,
        series: {
          seriesId: params.id,
          title: v.series_name || hit.title,
          synopsis: v.series_intro || hit.intro,
          coverUrl: hit.coverUrl,
          episodeCount: hit.episodeCount || v.episode_cnt,
          playCount: hit.playCount,
          firstVideoId: hit.firstVideoId,
        },
        episodes: hit.firstVideoId ? [{ videoId: hit.firstVideoId, episodeIndex: '1' }] : [],
        isFallback: true,
        warning: 'Viewing cached basic info. Apify quota exceeded.',
      }];
    }
    throw err;
  }
}));

// Downloads can take minutes, so start an async run and let the client poll.
app.post('/api/download', wrap(async ({ body }) => {
  if (Array.isArray(body.videoIds)) {
    const ids = [...new Set(body.videoIds.map(String))].filter(isId);
    if (!ids.length) throw new Error('No valid episode ids');
    if (ids.length <= 100) {
      const { data } = await apify(`/acts/${ACTORS.dlVideo}/runs`, { videoIds: ids });
      return { runId: data.id, runIds: [data.id] };
    }
    // If more than 100 episodes, chunk into batches of 80 to respect Apify's max 100 input limit
    const chunkSize = 80;
    const runIds = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const { data } = await apify(`/acts/${ACTORS.dlVideo}/runs`, { videoIds: chunk });
      runIds.push(data.id);
    }
    return { runId: runIds.join(','), runIds };
  }
  if (!isId(body.seriesId)) throw new Error('Invalid series id');
  const { data } = await apify(`/acts/${ACTORS.download}/runs`, { seriesIds: [body.seriesId] });
  return { runId: data.id, runIds: [data.id] };
}));

app.get('/api/download/:runId', wrap(async ({ params }) => {
  const ids = params.runId.split(',').filter(Boolean);
  if (ids.length <= 1) {
    const runId = ids[0] || params.runId;
    const { data: run } = await apify(`/actor-runs/${encodeURIComponent(runId)}`);
    const done = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status);
    const items = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true`).catch(() => []);
    return { status: run.status, done, items };
  }

  // Multiple runs aggregation
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const { data: run } = await apify(`/actor-runs/${encodeURIComponent(id)}`);
        const done = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status);
        const items = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true`).catch(() => []);
        return { status: run.status, done, items };
      } catch {
        return { status: 'FAILED', done: true, items: [] };
      }
    })
  );

  const done = results.every((r) => r.done);
  const items = results.flatMap((r) => r.items);
  const hasRunning = results.some((r) => r.status === 'RUNNING');
  const status = done ? (results.some((r) => r.status === 'SUCCEEDED') ? 'SUCCEEDED' : 'FAILED') : (hasRunning ? 'RUNNING' : 'READY');
  return { status, done, items };
}));

// Diagnostic: reports exactly what the image server returns for a cover URL.
app.get('/api/imgcheck', async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || /^[\d.]+$/.test(u.hostname))
      return res.json({ error: 'blocked url' });
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || '';
    res.json({
      status: r.status, type, bytes: buf.length, host: u.hostname,
      ext: (u.pathname.match(/\.(\w+)$/) || [])[1] || null,
      preview: type.startsWith('image/') ? undefined : buf.subarray(0, 160).toString('utf8'),
    });
  } catch (e) { res.json({ error: e.cause?.code || e.message }); }
});

// Forces a real file download (with a filename) for signed Apify KVS links.
app.get('/api/file', async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    if (u.protocol !== 'https:' || u.hostname !== 'api.apify.com') return res.sendStatus(400);
    const name = String(req.query.name || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
    const r = await fetch(u);
    if (!r.ok || !r.body) return res.sendStatus(502);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.mp4`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    const len = r.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    Readable.fromWeb(r.body).pipe(res);
  } catch { res.sendStatus(502); }
});

// Image proxy: fetches covers server-side (no Referer) and converts HEIC -> JPEG,
// because browsers cannot display HEIC.
const imgCache = new Map();
let active = 0; const waiters = [];
const acquire = () => (active < 3 ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => { const n = waiters.shift(); n ? n() : active--; };
const isHeic = (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' &&
  /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(b.toString('ascii', 8, 12));

app.get('/api/img', async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    const bad = u.protocol !== 'https:' || u.hostname === 'localhost' ||
      /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || !u.hostname.includes('.');
    if (bad) return res.sendStatus(400);
    const send = ({ type, body }) => {
      res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      res.send(body);
    };
    const hit = imgCache.get(u.href);
    if (hit) return send(hit);

    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    let type = r.headers.get('content-type') || '';
    let body = Buffer.from(await r.arrayBuffer());
    if (!r.ok) return res.status(404).send(`upstream ${r.status} ${type}`);
    if (isHeic(body) || /hei[cf]/i.test(type)) {
      await acquire();
      try { body = Buffer.from(await convert({ buffer: body, format: 'JPEG', quality: 0.8 })); type = 'image/jpeg'; }
      finally { release(); }
    } else if (!type.startsWith('image/')) {
      return res.status(404).send(`upstream not an image: ${type}`);
    }
    const out = { type, body };
    if (imgCache.size > 600) imgCache.delete(imgCache.keys().next().value);
    imgCache.set(u.href, out);
    send(out);
  } catch (e) { res.status(502).send(String(e.message || e)); }
});

app.use(express.static('dist'));
app.get('*', (_, res) => res.sendFile(path.resolve('dist/index.html')));

const isMain = process.argv[1] && (
  process.argv[1].endsWith('server.js') ||
  process.argv[1].endsWith('server')
);

if (isMain && !process.env.VERCEL) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log('API on :' + port));
}

export default app;
