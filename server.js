// Thin proxy so the Apify token never reaches the browser.
import dotenv from 'dotenv';
import express from 'express';
import convert from 'heic-convert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
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

// In Standalone Mode, requests are served without token restriction.
app.use((req, res, next) => {
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

// In-memory indexing of all pre-cached series details (.cache/series-*.json)
const seriesCacheMap = new Map();
function loadAllSeriesCache() {
  try {
    const cacheDirs = [path.resolve('.cache'), CACHE_DIR];
    for (const dir of cacheDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter((f) => f.startsWith('series-') && f.endsWith('.json'));
        for (const f of files) {
          const id = f.replace(/^series-/, '').replace(/\.json$/, '');
          try {
            const content = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const items = content?.items || (Array.isArray(content) ? content : [content]);
            if (items && items.length) {
              seriesCacheMap.set(id, items);
            }
          } catch {}
        }
      }
    }
    console.log(`[Standalone Engine] Loaded ${seriesCacheMap.size} pre-cached series details.`);
  } catch (err) {
    console.warn('[Standalone Engine] Warning loading series cache:', err.message);
  }
}
loadAllSeriesCache();

app.get('/api/apify-status', async (req, res) => {
  const token = getToken();
  const cache = readCache();
  const cachedCount = cache?.items?.length || 0;
  if (!token) {
    return res.json({
      configured: false,
      standalone: true,
      ok: true,
      cachedCount,
      currentUsd: 0,
      maxUsd: 0,
      limitExceeded: false,
      mode: 'standalone'
    });
  }
  try {
    const r = await fetch(BASE + '/users/me/limits', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) {
      return res.json({
        configured: true,
        standalone: true,
        ok: false,
        cachedCount,
        currentUsd: 0,
        maxUsd: 5,
        limitExceeded: false,
        error: await r.text()
      });
    }
    const { data } = await r.json();
    const maxUsd = data?.limits?.maxMonthlyUsageUsd ?? 5;
    const currentUsd = data?.current?.monthlyUsageUsd ?? 0;
    const limitExceeded = currentUsd >= maxUsd;
    res.json({
      configured: true,
      standalone: limitExceeded,
      ok: !limitExceeded,
      limitExceeded,
      currentUsd: +currentUsd.toFixed(2),
      maxUsd,
      cycleEnd: data?.monthlyUsageCycle?.endAt,
      cachedCount
    });
  } catch (err) {
    res.json({ configured: false, standalone: true, ok: true, cachedCount, error: err.message });
  }
});

app.get('/api/home', wrap(async ({ query }) => {
  const n = Math.min(+query.limit || 200, 1000);
  const forceRefresh = query.refresh === 'true' || query.refresh === '1';
  const c = readCache();
  const cachedItems = c?.items || [];

  const token = getToken();
  // Standalone mode: if no token or not force-refreshing, serve instant cached library
  if (!forceRefresh || !token) {
    return cachedItems.slice(0, n);
  }

  try {
    const items = await sync(ACTORS.feed, { maxResults: n, includeRaw: true });
    const good = items.filter((i) => i.success !== false);
    if (good.length) {
      const existing = cachedItems;
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
    return cachedItems.slice(0, n);
  } catch (err) {
    console.warn(`Feed fetch warning (${err.message}). Serving standalone cached data.`);
    return cachedItems.slice(0, n);
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

  // 1. Search in home.json
  const localMatches = existing.filter((item) => {
    const text = JSON.stringify(item).toLowerCase();
    return text.includes(qLower);
  });

  // 2. Also search across pre-cached series in seriesCacheMap
  for (const [id, items] of seriesCacheMap.entries()) {
    if (localMatches.some((it) => getId(it) === id)) continue;
    const text = JSON.stringify(items).toLowerCase();
    if (text.includes(qLower)) {
      const sItem = items[0];
      if (sItem) {
        localMatches.push({
          seriesId: id,
          title: sItem.series?.title || sItem.seriesTitle,
          intro: sItem.series?.intro || sItem.series?.synopsis,
          coverUrl: sItem.series?.coverUrl,
          episodeCount: sItem.series?.episodeCount || sItem.episodes?.length,
          tags: []
        });
      }
    }
  }

  const token = getToken();
  if (!token) {
    return localMatches;
  }

  try {
    const results = await sync(ACTORS.search, { queries: [q], maxPages });
    const good = results.filter((i) => i.success !== false);
    if (good.length) {
      const map = new Map();
      existing.forEach((it) => { const id = getId(it); if (id) map.set(id, it); });
      good.forEach((it) => { const id = getId(it); if (id) map.set(id, it); });
      const merged = Array.from(map.values());
      saveCache(CACHE_FILE, { t: c?.t || Date.now(), requested: merged.length, items: merged });

      const resultMap = new Map();
      good.forEach((it) => { const id = getId(it); if (id) resultMap.set(id, it); });
      localMatches.forEach((it) => { const id = getId(it); if (id) resultMap.set(id, it); });
      return Array.from(resultMap.values());
    }
    return localMatches;
  } catch (err) {
    console.warn(`Search upstream warning (${err.message}). Using local standalone matches.`);
    return localMatches;
  }
}));

// Series details: Offline-first with instant fallback
app.get('/api/series/:id', wrap(async ({ params }) => {
  if (!isId(params.id)) throw new Error('Invalid series id');
  
  // 1. Check in-memory pre-loaded series cache
  if (seriesCacheMap.has(params.id)) {
    return seriesCacheMap.get(params.id);
  }

  // 2. Check disk tmp or bundled
  const tmpSeriesFile = path.join(CACHE_DIR, `series-${params.id}.json`);
  const bundledSeriesFile = path.resolve(`.cache/series-${params.id}.json`);
  let cached = null;
  try {
    if (fs.existsSync(tmpSeriesFile)) {
      cached = JSON.parse(fs.readFileSync(tmpSeriesFile, 'utf8'));
    } else if (fs.existsSync(bundledSeriesFile)) {
      cached = JSON.parse(fs.readFileSync(bundledSeriesFile, 'utf8'));
    }
    const items = cached?.items || (Array.isArray(cached) ? cached : [cached]);
    const hasEpisodes = (items?.[0]?.episodes?.length || 0) > 0;
    if (hasEpisodes) {
      seriesCacheMap.set(params.id, items);
      return items;
    }
  } catch {}

  // 3. Fallback: check in home.json
  const home = readCache();
  const hit = home?.items?.find((i) => {
    const d = i.data || i;
    const v = d.video_data?.[0] || d;
    const id = String(v.series_id || v.seriesId || d.series_id || d.seriesId || i.seriesId || '');
    return id === String(params.id);
  });

  const buildFallback = (h) => {
    const d = h.data || h;
    const v = d.video_data?.[0] || d;
    const epCount = +(h.episodeCount || v.episode_cnt || 1);
    const epList = [];
    if (h.firstVideoId || v.first_vid) {
      epList.push({ videoId: String(h.firstVideoId || v.first_vid), episodeIndex: '1', title: 'ភាគ ១' });
    }
    for (let e = epList.length + 1; e <= Math.min(epCount, 200); e++) {
      epList.push({
        videoId: `${params.id}_ep_${e}`,
        episodeIndex: String(e),
        title: `ភាគ ${e}`,
        isSynthetic: true
      });
    }
    return [{
      success: true,
      seriesId: params.id,
      series: {
        seriesId: params.id,
        title: v.series_name || v.series_title || h.title || 'Hongguo Drama',
        synopsis: v.series_intro || h.intro || '',
        coverUrl: h.coverUrl || v.series_cover,
        episodeCount: epCount,
        playCount: h.playCount || v.series_play_cnt,
        firstVideoId: h.firstVideoId || v.first_vid,
      },
      episodes: epList,
      isFallback: true,
      standalone: true,
    }];
  };

  const token = getToken();
  if (!token) {
    if (hit) return buildFallback(hit);
    return [{
      success: true,
      seriesId: params.id,
      series: {
        seriesId: params.id,
        title: `Series ${params.id}`,
        synopsis: 'Standalone Mode',
        episodeCount: 1,
      },
      episodes: [{ videoId: params.id, episodeIndex: '1', title: 'ភាគ ១' }],
      isFallback: true,
      standalone: true,
    }];
  }

  try {
    const items = await sync(ACTORS.detail, { seriesIds: [params.id] });
    if (items.some((i) => i.success !== false)) {
      saveCache(tmpSeriesFile, { t: Date.now(), items });
      seriesCacheMap.set(params.id, items);
      return items;
    }
    if (hit) return buildFallback(hit);
    return items;
  } catch (err) {
    console.warn(`Series detail upstream warning for ${params.id}:`, err.message);
    if (hit) return buildFallback(hit);
    return [{
      success: true,
      seriesId: params.id,
      series: {
        seriesId: params.id,
        title: `Series ${params.id}`,
        synopsis: 'Standalone Mode',
        episodeCount: 1,
      },
      episodes: [{ videoId: params.id, episodeIndex: '1', title: 'ភាគ ១' }],
      isFallback: true,
      standalone: true,
    }];
  }
}));

// Downloads: Standalone-aware
app.post('/api/download', wrap(async ({ body }) => {
  const token = getToken();
  if (Array.isArray(body.videoIds)) {
    const ids = [...new Set(body.videoIds.map(String))].filter(isId);
    if (!ids.length) throw new Error('No valid episode ids');

    if (!token) {
      const fakeRunId = 'standalone_' + Date.now();
      return { runId: fakeRunId, runIds: [fakeRunId], standalone: true };
    }

    if (ids.length <= 100) {
      const { data } = await apify(`/acts/${ACTORS.dlVideo}/runs`, { videoIds: ids });
      return { runId: data.id, runIds: [data.id] };
    }

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
  if (!token) {
    const fakeRunId = 'standalone_' + Date.now();
    return { runId: fakeRunId, runIds: [fakeRunId], standalone: true };
  }

  const { data } = await apify(`/acts/${ACTORS.download}/runs`, { seriesIds: [body.seriesId] });
  return { runId: data.id, runIds: [data.id] };
}));

app.get('/api/download/:runId', wrap(async ({ params }) => {
  if (String(params.runId).startsWith('standalone_')) {
    return {
      status: 'FAILED',
      done: true,
      standalone: true,
      items: [],
      error: 'STANDALONE_NOTICE'
    };
  }

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
    let type = r.headers.get('content-type') || '';
    let isEncrypted = false;
    let det = detectImageType(buf);
    if (!det && !isHeic(buf)) {
      const dec = decryptYeguoMedia(buf);
      if (dec && detectImageType(dec)) {
        isEncrypted = true;
        det = detectImageType(dec);
        type = det;
      }
    } else if (det) {
      type = det;
    }
    res.json({
      status: r.status, type, bytes: buf.length, host: u.hostname,
      isEncrypted,
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

// ---- Yeguo (yeguodj.com) Downloader & Streaming Engine ------------------
// Auto-detect FFmpeg binary path across Windows & UNIX environments
function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where.exe ffmpeg' : 'which ffmpeg';
    const whereOut = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const firstLine = whereOut.split(/[\r\n]+/)[0]?.trim();
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch {}

  const possible = [
    'C:\\Users\\user\\AppData\\Local\\Python\\bin\\ffmpeg.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Python', 'bin', 'ffmpeg.exe'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Python', 'bin', 'ffmpeg.exe'),
    path.join(process.env.PROGRAMFILES || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ].filter(Boolean);

  for (const p of possible) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const FFMPEG_BIN = findFfmpeg();
const hasFfmpeg = Boolean(FFMPEG_BIN && fs.existsSync(FFMPEG_BIN));
if (hasFfmpeg) {
  const dir = path.dirname(FFMPEG_BIN);
  if (!process.env.PATH.includes(dir)) {
    process.env.PATH = `${dir};${process.env.PATH}`;
  }
  console.log(`[FFmpeg Engine] Detected binary: ${FFMPEG_BIN}`);
} else {
  console.log('[FFmpeg Engine] No local FFmpeg binary found. Pure JavaScript HLS decryption active (Vercel Serverless Ready).');
}

const YEGUO_CONFIG = {
  key: '2acf7e91e9864673',
  iv: '1c29882d3ddfcfd6',
  signKey: '5589d41f92a597d016b037ac37db243d',
  mediaKey: 'f5d965df75336270',
  mediaIv: '97b60394abc2fbe1',
  baseUrl: 'https://www.yeguodj.com/api.php',
};

function decryptYeguoMedia(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 16) return null;
  try {
    const key = Buffer.from(YEGUO_CONFIG.mediaKey, 'utf8');
    const iv = Buffer.from(YEGUO_CONFIG.mediaIv, 'utf8');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
  } catch {
    return null;
  }
}

function detectImageType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length > 12 && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function decryptYeguoData(encryptedBase64) {
  if (!encryptedBase64 || typeof encryptedBase64 !== 'string') return null;
  try {
    const key = Buffer.from(YEGUO_CONFIG.key, 'utf8');
    const iv = Buffer.from(YEGUO_CONFIG.iv, 'utf8');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    let decrypted = decipher.update(encryptedBase64.replace(/ /g, '+'), 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (err) {
    console.warn('[Yeguo Decrypt Error]', err.message);
    return null;
  }
}

async function callYeguoApi(endpoint, extraParams = {}) {
  const params = new URLSearchParams({
    bundleId: 'com.pwa.mater',
    version: '1.3.2',
    oauth_type: 'web',
    language: 'zh',
    via: 'pwa',
    oauth_id: '7d05538c4b8a5e74e82f93c0dab0163c',
    token: '',
    trace_id: '7d05538c4b8a5e74e82f93c0dab0163c',
    ...extraParams,
  });

  const res = await fetch(`${YEGUO_CONFIG.baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://www.yeguodj.com',
      'Referer': 'https://www.yeguodj.com/'
    },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Yeguo API upstream error ${res.status}`);
  }

  const json = await res.json();
  if (json.data) {
    const dec = decryptYeguoData(json.data);
    return dec?.data ?? dec;
  }
  return json;
}

app.get('/api/yeguo/home', wrap(async ({ query }) => {
  const page = Math.max(1, +query.page || 1);
  const limit = Math.min(100, Math.max(1, +query.limit || 24));
  const data = await callYeguoApi('/api/theater/exploreList', { page, limit });
  const rawList = data?.list || (Array.isArray(data) ? data : []);
  const items = rawList.map((item) => ({
    id: String(item.video_id || item.id),
    title: item.title || 'Untitled',
    cover: item.cover || '',
    episodes: item.episodes || item.episode_count || 1,
    desc: item.description || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    platform: 'yeguo',
    isYeguo: true,
  }));
  return items;
}));

app.post('/api/yeguo/search', wrap(async ({ body }) => {
  const q = String(body.query || '').trim();
  if (!q) throw new Error('Empty query');
  const page = Math.max(1, +body.page || 1);
  const limit = Math.min(100, Math.max(1, +body.limit || 24));
  const data = await callYeguoApi('/api/search/result', { keyword: q, page, limit });
  const rawList = data?.list || (Array.isArray(data) ? data : []);
  const items = rawList.map((item) => ({
    id: String(item.video_id || item.id),
    title: item.title || 'Untitled',
    cover: item.cover || '',
    episodes: item.episodes || item.episode_count || 1,
    desc: item.description || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    platform: 'yeguo',
    isYeguo: true,
  }));
  return items;
}));

app.get('/api/yeguo/series/:id', wrap(async ({ params }) => {
  const videoId = String(params.id).trim();
  if (!/^\d+$/.test(videoId)) throw new Error('Invalid Yeguo series id');

  // 1. Fetch drama detail
  const detail = await callYeguoApi('/api/playlet/detail', {
    video_id: videoId,
    episode_id: '0',
    related_limit: '10',
  });

  if (!detail) throw new Error('Yeguo drama not found');

  const firstEpId = detail.episodes?.[0]?.id || 0;

  // 2. Fetch play info which contains direct video_urls for all episodes
  let play = null;
  try {
    play = await callYeguoApi('/api/playlet/play', {
      video_id: videoId,
      episode_id: String(firstEpId),
    });
  } catch (err) {
    console.warn(`[Yeguo Play API Error] ${err.message}`);
  }

  const allEps = play?.episodeAll || detail?.episodes || [];
  const dramaTitle = detail.title || play?.video_title || `Yeguo Drama ${videoId}`;
  const dramaDesc = detail.description || play?.description || '';
  const dramaCover = detail.cover || play?.cover_img || '';

  const mappedEpisodes = allEps.map((ep, idx) => {
    const epNum = ep.sort ?? ep.index ?? (idx + 1);
    const epId = String(ep.id || `${videoId}_${epNum}`);
    const epTitle = ep.episode_title || ep.title || `${dramaTitle} 第${epNum}集`;
    const vUrl = ep.video_url || play?.video_url || '';
    const safeTitle = `${dramaTitle} Ep ${epNum}`;
    return {
      videoId: epId,
      episodeIndex: String(epNum),
      title: epTitle,
      duration: ep.duration || ep.episode_duration || 0,
      videoUrl: vUrl,
      playUrl: vUrl || `/api/yeguo/stream?videoId=${videoId}&episodeId=${epId}`,
      downloadUrl: `/api/yeguo/stream?videoId=${videoId}&episodeId=${epId}&download=1&name=${encodeURIComponent(safeTitle)}${vUrl ? `&url=${encodeURIComponent(vUrl)}` : ''}`,
      isYeguo: true,
      platform: 'yeguo',
      definition: ep.resolution || '720p',
      codec: 'H.264',
    };
  });

  return [{
    success: true,
    seriesId: videoId,
    platform: 'yeguo',
    isYeguo: true,
    series: {
      seriesId: videoId,
      title: dramaTitle,
      synopsis: dramaDesc,
      coverUrl: dramaCover,
      episodeCount: detail.episode_count || mappedEpisodes.length,
      tags: detail.tags || [],
    },
    episodes: mappedEpisodes,
  }];
}));

// Fetch fresh stream url for a single episode on demand
app.get('/api/yeguo/play', wrap(async ({ query }) => {
  const videoId = String(query.videoId || '');
  const episodeId = String(query.episodeId || '');
  if (!videoId) throw new Error('Missing videoId');
  const play = await callYeguoApi('/api/playlet/play', {
    video_id: videoId,
    episode_id: episodeId || undefined,
  });
  return {
    success: true,
    videoId,
    episodeId,
    videoUrl: play?.video_url || '',
  };
}));

// Pure JavaScript HLS Decryption and Streaming (No FFmpeg required, Vercel-ready)
async function streamDecryptedHls(m3u8Url, res, fileName, isDownload) {
  try {
    const r = await fetch(m3u8Url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': m3u8Url.includes('tjyyjk.cn') || m3u8Url.includes('huangguo') ? 'https://huangguoai.com/' : 'https://www.yeguodj.com/',
      }
    });
    if (!r.ok) {
      if (!res.headersSent) res.status(r.status).send(`Failed to fetch playlist (${r.status})`);
      return;
    }
    const text = await r.text();
    const lines = text.split(/\r?\n/);
    let keyBuf = null;
    let ivBuf = null;
    const segments = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#EXT-X-KEY:')) {
        const uriMatch = trimmed.match(/URI=["']([^"']+)["']/i);
        const ivMatch = trimmed.match(/IV=0x([0-9a-fA-F]+)/i);
        if (uriMatch) {
          const keyUrl = new URL(uriMatch[1], m3u8Url).href;
          const keyRes = await fetch(keyUrl);
          if (keyRes.ok) {
            keyBuf = Buffer.from(await keyRes.arrayBuffer());
          }
        }
        if (ivMatch) {
          ivBuf = Buffer.from(ivMatch[1], 'hex');
        }
      } else if (trimmed && !trimmed.startsWith('#')) {
        segments.push(new URL(trimmed, m3u8Url).href);
      }
    }

    if (!segments.length) {
      if (!res.headersSent) res.status(404).send('No video segments found in playlist');
      return;
    }

    res.set({
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Disposition': `${isDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(fileName)}.mp4"; filename*=UTF-8''${encodeURIComponent(fileName)}.mp4`
    });

    const BATCH_SIZE = 6;
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      if (res.writableEnded || res.closed) break;
      const batchUrls = segments.slice(i, i + BATCH_SIZE);
      const batchPromises = batchUrls.map(async (segUrl, bIdx) => {
        const segIdx = i + bIdx;
        try {
          const segRes = await fetch(segUrl);
          if (!segRes.ok) return null;
          const encBuf = Buffer.from(await segRes.arrayBuffer());
          if (keyBuf) {
            let segIv = ivBuf;
            if (!segIv) {
              segIv = Buffer.alloc(16);
              segIv.writeUInt32BE(segIdx, 12);
            }
            const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, segIv);
            decipher.setAutoPadding(true);
            return Buffer.concat([decipher.update(encBuf), decipher.final()]);
          }
          return encBuf;
        } catch {
          return null;
        }
      });

      const batchChunks = await Promise.all(batchPromises);
      for (const chunk of batchChunks) {
        if (chunk && !res.writableEnded && !res.closed) {
          res.write(chunk);
        }
      }
    }
    res.end();
  } catch (err) {
    console.warn('[Pure JS HLS Stream Error]', err.message);
    if (!res.headersSent) res.status(500).send('HLS stream error: ' + err.message);
  }
}

// Streaming and Remuxing endpoint: converts HLS m3u8 stream to MP4 on-the-fly
app.get('/api/yeguo/stream', async (req, res) => {
  try {
    let rawUrl = String(req.query.url || '');
    const videoId = String(req.query.videoId || '');
    const episodeId = String(req.query.episodeId || '');

    // Auto-refresh URL if missing or if videoId & episodeId are provided
    if ((!rawUrl || rawUrl === 'undefined') && videoId && episodeId) {
      try {
        const play = await callYeguoApi('/api/playlet/play', { video_id: videoId, episode_id: episodeId });
        rawUrl = play?.video_url || '';
      } catch (e) {
        console.warn(`[Auto-refresh URL Error] ${e.message}`);
      }
    }

    if (!rawUrl) return res.status(400).send('Missing video url');

    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return res.status(400).send('Invalid protocol');
    }

    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const fileName = String(req.query.name || 'yeguo_video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);

    // If FFmpeg is NOT installed (e.g. on Vercel Serverless), stream decrypted HLS directly via pure JS
    if (!hasFfmpeg) {
      return await streamDecryptedHls(rawUrl, res, fileName, isDownload);
    }

    const headers = [
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin: https://www.yeguodj.com',
      'Referer: https://www.yeguodj.com/'
    ].join('\r\n') + '\r\n';

    res.set({
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });

    if (isDownload) {
      res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}.mp4"; filename*=UTF-8''${encodeURIComponent(fileName)}.mp4`);
    } else {
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}.mp4"; filename*=UTF-8''${encodeURIComponent(fileName)}.mp4`);
    }

    const ffmpegArgs = [
      '-headers', headers,
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', rawUrl,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    ];

    const ffmpegProc = spawn(FFMPEG_BIN, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrData = '';
    ffmpegProc.stderr.on('data', (d) => {
      stderrData += d.toString('utf8');
      if (stderrData.length > 2000) stderrData = stderrData.slice(-2000);
    });

    req.on('close', () => {
      try {
        if (!ffmpegProc.killed) {
          ffmpegProc.kill();
        }
      } catch {}
    });

    ffmpegProc.on('error', (err) => {
      console.warn('[FFmpeg Stream Error]', err.message);
      if (!res.headersSent) res.status(500).send('FFmpeg process error: ' + err.message);
    });

    ffmpegProc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[FFmpeg Stream Warning] Exit code ${code}: ${stderrData.slice(-300)}`);
      }
    });

    ffmpegProc.stdout.pipe(res);
  } catch (err) {
    console.warn('[Stream Route Error]', err.message);
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

// ---- Huangguo (huangguoai.com) Downloader & Streaming Engine -----------
app.get('/api/huangguo/home', wrap(async ({ query }) => {
  const page = Math.max(1, +query.page || 1);
  const limit = Math.min(100, Math.max(1, +query.limit || 24));
  const res = await fetch(`https://huangguoai.com/api/home/latest?page=${page}&size=${limit}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://huangguoai.com/'
    }
  });
  if (!res.ok) throw new Error(`Huangguo Home API error ${res.status}`);
  const json = await res.json();
  const rawItems = json?.data?.items || json?.data?.content || [];
  const items = rawItems.map((item) => {
    let cover = item.cover || '';
    if (cover && !cover.startsWith('http')) {
      cover = `https://pic.qnlycc.cn${cover.startsWith('/') ? '' : '/'}${cover}`;
    }
    return {
      id: String(item.id),
      title: item.title || 'Untitled',
      cover,
      episodes: item.episode_count || 1,
      desc: item.desc || item.description || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      platform: 'huangguo',
      isHuangguo: true,
    };
  });
  return items;
}));

app.post('/api/huangguo/search', wrap(async ({ body }) => {
  const q = String(body.query || '').trim();
  if (!q) throw new Error('Empty query');
  const page = Math.max(1, +body.page || 1);
  const limit = Math.min(100, Math.max(1, +body.limit || 24));

  let rawItems = [];
  try {
    const res = await fetch(`https://huangguoai.com/api/search?q=${encodeURIComponent(q)}&page=${page}&size=${limit}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://huangguoai.com/'
      }
    });
    if (res.ok) {
      const json = await res.json();
      rawItems = json?.data?.items || [];
    }
  } catch (err) {
    console.warn('[Huangguo Search Error]', err.message);
  }

  if (!rawItems.length) {
    try {
      const sRes = await fetch(`https://huangguoai.com/api/search/suggest?type=video&q=${encodeURIComponent(q)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://huangguoai.com/'
        }
      });
      if (sRes.ok) {
        const sJson = await sRes.json();
        rawItems = sJson?.data?.content || [];
      }
    } catch (err) {
      console.warn('[Huangguo Search Suggest Error]', err.message);
    }
  }

  const items = rawItems.map((item) => {
    let cover = item.cover || '';
    if (cover && !cover.startsWith('http')) {
      cover = `https://pic.qnlycc.cn${cover.startsWith('/') ? '' : '/'}${cover}`;
    }
    return {
      id: String(item.id),
      title: item.title || 'Untitled',
      cover,
      episodes: item.episode_count || 1,
      desc: item.desc || item.description || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      platform: 'huangguo',
      isHuangguo: true,
    };
  });
  return items;
}));

app.get('/api/huangguo/series/:id', wrap(async ({ params }) => {
  const videoId = String(params.id).trim();
  if (!/^\d+$/.test(videoId)) throw new Error('Invalid Huangguo series id');

  const res = await fetch(`https://huangguoai.com/api/videos/${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://huangguoai.com/'
    }
  });
  if (!res.ok) throw new Error(`Huangguo video detail upstream error ${res.status}`);
  const json = await res.json();
  const detail = json?.data;
  if (!detail || !detail.title) throw new Error('Huangguo drama not found');

  let cover = detail.cover || '';
  if (cover && !cover.startsWith('http')) {
    cover = `https://pic.qnlycc.cn${cover.startsWith('/') ? '' : '/'}${cover}`;
  }
  const dramaTitle = detail.title || `Huangguo Drama ${videoId}`;
  const dramaDesc = detail.description || '';
  const rawEpisodes = detail.episodes || [];

  // Pre-fetch playback streams for small series or up to 8 episodes in parallel
  const prefetchCount = Math.min(rawEpisodes.length, 8);
  const streamMap = new Map();
  if (prefetchCount > 0) {
    const prefetchPromises = rawEpisodes.slice(0, prefetchCount).map(async (ep) => {
      try {
        const pRes = await fetch(`https://huangguoai.com/api/videos/${videoId}/episodes/${ep.ep_num}/playback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://huangguoai.com/'
          },
          body: JSON.stringify({})
        });
        if (pRes.ok) {
          const pJson = await pRes.json();
          const m3u8 = pJson?.data?.streams?.main || '';
          if (m3u8) streamMap.set(ep.ep_num, m3u8);
        }
      } catch {}
    });
    await Promise.all(prefetchPromises);
  }

  const mappedEpisodes = rawEpisodes.map((ep, idx) => {
    const epNum = ep.ep_num ?? (idx + 1);
    const epId = `${videoId}_${epNum}`;
    const epTitle = ep.title || `${dramaTitle} 第${epNum}集`;
    const vUrl = streamMap.get(epNum) || '';
    const safeTitle = `${dramaTitle} Ep ${epNum}`;
    return {
      videoId: epId,
      episodeIndex: String(epNum),
      title: epTitle,
      duration: ep.duration || 0,
      videoUrl: vUrl,
      playUrl: vUrl || `/api/huangguo/stream?videoId=${videoId}&episodeId=${epNum}`,
      downloadUrl: `/api/huangguo/stream?videoId=${videoId}&episodeId=${epNum}&download=1&name=${encodeURIComponent(safeTitle)}${vUrl ? `&url=${encodeURIComponent(vUrl)}` : ''}`,
      isHuangguo: true,
      platform: 'huangguo',
      definition: '1080p',
      codec: 'H.264',
    };
  });

  return [{
    success: true,
    seriesId: videoId,
    platform: 'huangguo',
    isHuangguo: true,
    series: {
      seriesId: videoId,
      title: dramaTitle,
      synopsis: dramaDesc,
      coverUrl: cover,
      episodeCount: detail.episode_count || mappedEpisodes.length,
      tags: detail.tags || [],
    },
    episodes: mappedEpisodes,
  }];
}));

// Fetch fresh stream url for a single episode on demand
app.get('/api/huangguo/play', wrap(async ({ query }) => {
  const videoId = String(query.videoId || '').replace(/_\d+$/, '');
  const episodeId = String(query.episodeId || '1').replace(/^.*_/, '');
  if (!videoId) throw new Error('Missing videoId');

  const pRes = await fetch(`https://huangguoai.com/api/videos/${videoId}/episodes/${episodeId}/playback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://huangguoai.com/'
    },
    body: JSON.stringify({})
  });
  if (!pRes.ok) throw new Error(`Huangguo Playback upstream error ${pRes.status}`);
  const pJson = await pRes.json();
  const videoUrl = pJson?.data?.streams?.main || '';
  return {
    success: true,
    videoId: `${videoId}_${episodeId}`,
    episodeId,
    videoUrl,
  };
}));

// Remuxing & fallback streaming endpoint for Huangguo
app.get('/api/huangguo/stream', async (req, res) => {
  try {
    let rawUrl = String(req.query.url || '');
    let videoId = String(req.query.videoId || '').replace(/_\d+$/, '');
    let episodeId = String(req.query.episodeId || '1').replace(/^.*_/, '');

    if ((!rawUrl || rawUrl === 'undefined') && videoId && episodeId) {
      try {
        const pRes = await fetch(`https://huangguoai.com/api/videos/${videoId}/episodes/${episodeId}/playback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://huangguoai.com/'
          },
          body: JSON.stringify({})
        });
        if (pRes.ok) {
          const pJson = await pRes.json();
          rawUrl = pJson?.data?.streams?.main || '';
        }
      } catch (e) {
        console.warn(`[Huangguo Auto-refresh URL Error] ${e.message}`);
      }
    }

    if (!rawUrl) return res.status(400).send('Missing video url');

    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const fileName = String(req.query.name || 'huangguo_video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);

    if (!hasFfmpeg) {
      return await streamDecryptedHls(rawUrl, res, fileName, isDownload);
    }

    const headers = [
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer: https://huangguoai.com/'
    ].join('\r\n') + '\r\n';

    res.set({
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });

    if (isDownload) {
      res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}.mp4"; filename*=UTF-8''${encodeURIComponent(fileName)}.mp4`);
    } else {
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}.mp4"; filename*=UTF-8''${encodeURIComponent(fileName)}.mp4`);
    }

    const ffmpegArgs = [
      '-headers', headers,
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', rawUrl,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    ];

    const ffmpegProc = spawn(FFMPEG_BIN, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    req.on('close', () => {
      try {
        if (!ffmpegProc.killed) ffmpegProc.kill();
      } catch {}
    });
    ffmpegProc.on('error', (err) => {
      if (!res.headersSent) res.status(500).send('FFmpeg process error: ' + err.message);
    });
    ffmpegProc.stdout.pipe(res);
  } catch (err) {
    console.warn('[Huangguo Stream Route Error]', err.message);
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

// ---- Khmer Subtitle Generation, Storage & Export Engine ----------------
const SUBTITLE_DIR = path.join(CACHE_DIR, 'subtitles');

function parseTimeToSeconds(val) {
  if (typeof val === 'number') return Math.max(0, val);
  if (!val) return 0;
  const s = String(val).trim().replace(',', '.');
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  const num = parseFloat(s);
  return isNaN(num) ? 0 : num;
}

function formatSrtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const remS = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

app.get('/api/subtitles/:videoId', wrap(async ({ params }) => {
  const id = String(params.videoId).replace(/[\\/:*?"<>|]/g, '_');
  const subFile = path.join(SUBTITLE_DIR, `${id}.json`);
  if (fs.existsSync(subFile)) {
    try {
      const content = JSON.parse(fs.readFileSync(subFile, 'utf8'));
      return { success: true, videoId: id, subtitles: content?.subtitles || content || [] };
    } catch {}
  }
  return { success: false, found: false, subtitles: [] };
}));

app.post('/api/subtitles/save', wrap(async ({ body }) => {
  const id = String(body.videoId).replace(/[\\/:*?"<>|]/g, '_');
  if (!id) throw new Error('Missing videoId');
  const subs = Array.isArray(body.subtitles) ? body.subtitles : [];
  try {
    fs.mkdirSync(SUBTITLE_DIR, { recursive: true });
    const subFile = path.join(SUBTITLE_DIR, `${id}.json`);
    fs.writeFileSync(subFile, JSON.stringify({ videoId: id, updatedAt: Date.now(), subtitles: subs }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Subtitles] Save error (ignoring for serverless):', err.message);
  }
  return { success: true, count: subs.length };
}));

app.get('/api/subtitles/export/:videoId', async (req, res) => {
  try {
    const id = String(req.params.videoId).replace(/[\\/:*?"<>|]/g, '_');
    const name = String(req.query.name || `${id}_khmer`).replace(/[\\/:*?"<>|]/g, '_');
    const subFile = path.join(SUBTITLE_DIR, `${id}.json`);
    if (!fs.existsSync(subFile)) {
      return res.status(404).send('Subtitles not found');
    }
    const content = JSON.parse(fs.readFileSync(subFile, 'utf8'));
    const subs = content?.subtitles || content || [];
    let srt = '\uFEFF';
    subs.forEach((s, idx) => {
      srt += `${idx + 1}\r\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\r\n${s.text || ''}\r\n\r\n`;
    });
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}.srt"; filename*=UTF-8''${encodeURIComponent(name)}.srt`,
      'Access-Control-Allow-Origin': '*',
    });
    res.send(srt);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Pure JavaScript Audio Extraction from MPEG-TS & HLS (Zero FFmpeg required for Vercel Serverless)
function findAudioPid(tsBuf) {
  for (let i = 0; i + 188 <= Math.min(tsBuf.length, 188 * 2000); i += 188) {
    if (tsBuf[i] !== 0x47) continue;
    const pusi = (tsBuf[i + 1] & 0x40) !== 0;
    if (!pusi) continue;
    const pid = ((tsBuf[i + 1] & 0x1f) << 8) | tsBuf[i + 2];
    if (pid === 0) continue;
    const afc = (tsBuf[i + 3] >> 4) & 0x3;
    let offset = 4;
    if (afc === 2) continue;
    if (afc === 3) offset = 5 + tsBuf[i + 4];
    if (offset + 4 > 188) continue;
    if (tsBuf[i + offset] === 0x00 && tsBuf[i + offset + 1] === 0x00 && tsBuf[i + offset + 2] === 0x01) {
      const streamId = tsBuf[i + offset + 3];
      if ((streamId >= 0xC0 && streamId <= 0xDF) || streamId === 0xBD) return pid;
    }
  }
  return 257; // Default audio PID fallback
}

function extractAacFromTs(tsBuf, audioPid = 257) {
  const aacFrames = [];
  let inAudioPes = false;

  for (let i = 0; i + 188 <= tsBuf.length; i += 188) {
    if (tsBuf[i] !== 0x47) continue;
    const pusi = (tsBuf[i + 1] & 0x40) !== 0;
    const pid = ((tsBuf[i + 1] & 0x1f) << 8) | tsBuf[i + 2];
    if (pid !== audioPid) continue;

    const afc = (tsBuf[i + 3] >> 4) & 0x3;
    let offset = 4;
    if (afc === 2) continue;
    if (afc === 3) offset = 5 + tsBuf[i + 4];
    if (offset >= 188) continue;

    const chunk = tsBuf.subarray(i + offset, i + 188);

    if (pusi) {
      if (chunk.length >= 9 && chunk[0] === 0x00 && chunk[1] === 0x00 && chunk[2] === 0x01) {
        const pesHdrLen = 9 + chunk[8];
        if (chunk.length > pesHdrLen) {
          aacFrames.push(chunk.subarray(pesHdrLen));
          inAudioPes = true;
        }
      }
    } else if (inAudioPes) {
      aacFrames.push(chunk);
    }
  }
  return Buffer.concat(aacFrames);
}

async function extractAacFromHls(m3u8Url) {
  const r = await fetch(m3u8Url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': m3u8Url.includes('tjyyjk.cn') || m3u8Url.includes('huangguo') ? 'https://huangguoai.com/' : 'https://www.yeguodj.com/',
    }
  });
  if (!r.ok) throw new Error(`Failed to fetch playlist (${r.status})`);
  const text = await r.text();
  const lines = text.split(/\r?\n/);
  let keyBuf = null;
  let ivBuf = null;
  const segments = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-KEY:')) {
      const uriMatch = trimmed.match(/URI=["']([^"']+)["']/i);
      const ivMatch = trimmed.match(/IV=0x([0-9a-fA-F]+)/i);
      if (uriMatch) {
        const keyUrl = new URL(uriMatch[1], m3u8Url).href;
        const keyRes = await fetch(keyUrl, { signal: AbortSignal.timeout(6000) });
        if (keyRes.ok) keyBuf = Buffer.from(await keyRes.arrayBuffer());
      }
      if (ivMatch) ivBuf = Buffer.from(ivMatch[1], 'hex');
    } else if (trimmed && !trimmed.startsWith('#')) {
      segments.push(new URL(trimmed, m3u8Url).href);
    }
  }

  if (!segments.length) throw new Error('No video segments found in playlist');

  let audioPid = null;
  const aacChunks = [];
  const BATCH_SIZE = 25;

  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batchUrls = segments.slice(i, i + BATCH_SIZE);
    const batchDecrypted = await Promise.all(batchUrls.map(async (segUrl, bIdx) => {
      const segIdx = i + bIdx;
      try {
        const segRes = await fetch(segUrl, { signal: AbortSignal.timeout(8000) });
        if (!segRes.ok) return null;
        let buf = Buffer.from(await segRes.arrayBuffer());
        if (keyBuf) {
          let segIv = ivBuf;
          if (!segIv) {
            segIv = Buffer.alloc(16);
            segIv.writeUInt32BE(segIdx, 12);
          }
          const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, segIv);
          decipher.setAutoPadding(true);
          buf = Buffer.concat([decipher.update(buf), decipher.final()]);
        }
        return buf;
      } catch (err) {
        console.warn(`[extractAacFromHls] segment ${segIdx} error:`, err.message);
        return null;
      }
    }));

    for (const tsBuf of batchDecrypted) {
      if (!tsBuf || tsBuf.length < 188) continue;
      if (audioPid === null) audioPid = findAudioPid(tsBuf);
      const aac = extractAacFromTs(tsBuf, audioPid);
      if (aac && aac.length) aacChunks.push(aac);
    }
  }

  const finalAac = Buffer.concat(aacChunks);
  if (!finalAac.length) throw new Error('Could not extract audio track from video stream');
  return finalAac;
}

app.post('/api/subtitles/generate', wrap(async ({ body }) => {
  const videoId = String(body.videoId || '').replace(/[\\/:*?"<>|]/g, '_');
  const videoUrl = String(body.videoUrl || '').trim();
  const apiKey = String(body.apiKey || process.env.GEMINI_API_KEY || '').trim();
  const requestedModel = String(body.model || 'gemini-3.8-flash').trim();

  if (!videoId) throw new Error('Missing videoId');
  if (!videoUrl && !body.audioBase64) throw new Error('Missing videoUrl');
  if (!apiKey) throw new Error('Missing Gemini API Key. Please enter your API Key or set GEMINI_API_KEY in .env.');

  const subFile = path.join(SUBTITLE_DIR, `${videoId}.json`);
  if (!body.force && fs.existsSync(subFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(subFile, 'utf8'));
      if (cached?.subtitles?.length) {
        return { success: true, videoId, subtitles: cached.subtitles, fromCache: true };
      }
    } catch {}
  }

  let mediaBase64 = '';
  let mediaMimeType = 'audio/mp3';

  // Option 1: Direct audio base64 passed from client
  if (body.audioBase64) {
    mediaBase64 = String(body.audioBase64).replace(/^data:[^;]+;base64,/, '');
    mediaMimeType = body.mimeType || 'audio/mp3';
  }
  // Option 2: Local FFmpeg if available
  else if (hasFfmpeg) {
    try {
      const tempAudio = path.join(os.tmpdir(), `sub_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
      const headers = videoUrl.includes('huangguo') || videoUrl.includes('tjyyjk.cn')
        ? 'User-Agent: Mozilla/5.0\r\nReferer: https://huangguoai.com/\r\n'
        : videoUrl.includes('yeguo')
        ? 'User-Agent: Mozilla/5.0\r\nReferer: https://www.yeguodj.com/\r\n'
        : 'User-Agent: Mozilla/5.0\r\n';

      const ffmpegArgs = [
        '-headers', headers,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-y',
        '-i', videoUrl,
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-b:a', '64k',
        tempAudio
      ];

      await new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_BIN, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let errOutput = '';
        proc.stderr.on('data', (d) => { errOutput += d.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(tempAudio) && fs.statSync(tempAudio).size > 1000) {
            resolve();
          } else {
            reject(new Error(`FFmpeg audio extraction failed (code ${code}): ${errOutput.slice(-300)}`));
          }
        });
      });

      mediaBase64 = fs.readFileSync(tempAudio).toString('base64');
      mediaMimeType = 'audio/mp3';
      try { fs.unlinkSync(tempAudio); } catch {}
    } catch (ffErr) {
      console.warn('[Subtitles] Local FFmpeg extraction failed, falling back to pure JavaScript:', ffErr.message);
    }
  }

  // Option 3: Pure JavaScript Extraction (Zero FFmpeg required - Vercel Serverless ready)
  if (!mediaBase64) {
    let resolvedUrl = videoUrl;
    if (resolvedUrl.startsWith('/')) {
      const port = process.env.PORT || 3000;
      resolvedUrl = `http://127.0.0.1:${port}${resolvedUrl}`;
    }
    const isHls = /\.m3u8/i.test(resolvedUrl) || resolvedUrl.includes('yeguo') || resolvedUrl.includes('huangguo');
    if (isHls) {
      console.log('[Subtitles] Extracting AAC audio from HLS playlist via pure JavaScript (Serverless mode)...');
      const aacBuffer = await extractAacFromHls(resolvedUrl);
      mediaBase64 = aacBuffer.toString('base64');
      mediaMimeType = 'audio/aac';
      console.log(`[Subtitles] Extracted ${Math.round(aacBuffer.length / 1024)} KB clean AAC audio.`);
    } else {
      console.log('[Subtitles] Fetching direct video stream for Gemini processing...');
      const vRes = await fetch(resolvedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (!vRes.ok) throw new Error(`Failed to fetch video stream (${vRes.status})`);
      const vBuf = Buffer.from(await vRes.arrayBuffer());
      if (vBuf.length > 20 * 1024 * 1024) {
        throw new Error(`Video file too large (${Math.round(vBuf.length / 1024 / 1024)}MB) for serverless direct processing. Please run locally with FFmpeg.`);
      }
      mediaBase64 = vBuf.toString('base64');
      mediaMimeType = 'video/mp4';
    }
  }

  const systemInstructionText = `You are an expert film dubbing translator and subtitler specializing in translating foreign films and Chinese short dramas into authentic, natural, colloquial spoken Khmer subtitles (ភាសាខ្មែរសម្រាប់រឿងភាគខ្លី).

RULES:
1. Listen carefully to the spoken dialogue in this audio.
2. Transcribe and translate all dialogue into authentic, natural, dramatic spoken Khmer (100% Khmer text).
3. DO NOT leave any untranslated Chinese characters or foreign words inside the Khmer translation.
4. Translate idioms, exclamations, and emotions accurately with dramatic depth (e.g. "放肆" -> "ព្រហើនណាស់!", "慢着" -> "ចាំបន្តិច!").
5. Provide accurate timestamps (start, end) in seconds (numbers, e.g. 1.2, 4.5) or MM:SS.sss relative to this audio.
6. In "original", include the transcribed original Chinese sentence.

Return ONLY a valid JSON array of objects:
[
  { "start": 1.2, "end": 3.8, "text": "តើឯងគិតថាឯងជានរណា?", "original": "你以为你是谁？" }
]`;

  const payload = {
    systemInstruction: {
      parts: [{ text: systemInstructionText }]
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: mediaMimeType,
              data: mediaBase64
            }
          },
          {
            text: "Transcribe the spoken drama dialogue and translate it into authentic, natural spoken Khmer subtitles with exact timestamps. Return only a valid JSON array."
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 8192
    }
  };

  // Dynamically fetch available models from Google AI Studio if possible
  let dynamicModels = [];
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      if (Array.isArray(listData.models)) {
        dynamicModels = listData.models
          .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m) => m.name.replace(/^models\//, ''));
      }
    }
  } catch {}

  const priorityList = [
    requestedModel,
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.8-pro',
  ];

  const modelsToTry = [
    ...priorityList,
    ...dynamicModels.filter((m) =>
      !priorityList.includes(m) &&
      !m.includes('2.0') &&
      !m.includes('1.5') &&
      !m.includes('2.5') &&
      !m.includes('embedding') &&
      !m.includes('imagen') &&
      !m.includes('aqa')
    )
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  console.log('[Subtitle AI] Models queue:', modelsToTry);

  let rawJson = null;
  const modelErrors = [];

  for (let idx = 0; idx < modelsToTry.length; idx++) {
    const model = modelsToTry[idx];
    const isLastModel = idx === modelsToTry.length - 1;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(28000)
      });
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        const errMsg = errJson.error?.message || resp.statusText;
        // If temporary high-demand and it is the last model available, retry once after 1.5s
        if (isLastModel && (resp.status === 503 || resp.status === 429 || errMsg.includes('high demand') || errMsg.includes('temporary'))) {
          console.warn(`[Subtitle AI] Final model ${model} high demand (${errMsg}), retrying once in 1.5s...`);
          await new Promise((r) => setTimeout(r, 1500));
          const retryResp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(28000)
          });
          if (retryResp.ok) {
            const data = await retryResp.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              rawJson = text;
              break;
            }
          }
        }
        throw new Error(`[${model}] ${errMsg}`);
      }
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        rawJson = text;
        break;
      }
    } catch (e) {
      modelErrors.push(e.message);
      console.warn(`[Subtitle AI] Model ${model} attempt failed: ${e.message}`);
    }
  }

  if (!rawJson) {
    throw new Error(`Failed to generate subtitles with Gemini AI: ${modelErrors.join(' | ')}`);
  }

  let parsed = [];
  try {
    const cleanText = rawJson.replace(/```json\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleanText);
    if (!Array.isArray(parsed) && parsed.subtitles && Array.isArray(parsed.subtitles)) {
      parsed = parsed.subtitles;
    }
  } catch (err) {
    throw new Error(`Failed to parse AI response as JSON: ${err.message}`);
  }

  const formattedSubtitles = (Array.isArray(parsed) ? parsed : []).map((item, idx) => {
    const start = parseTimeToSeconds(item.start);
    const end = Math.max(start + 0.5, parseTimeToSeconds(item.end));
    return {
      id: idx + 1,
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      text: String(item.text || '').trim(),
      original: String(item.original || '').trim(),
    };
  }).filter((s) => s.text);

  formattedSubtitles.sort((a, b) => a.start - b.start);

  try {
    fs.mkdirSync(SUBTITLE_DIR, { recursive: true });
    fs.writeFileSync(subFile, JSON.stringify({
      videoId,
      updatedAt: Date.now(),
      model: requestedModel,
      subtitles: formattedSubtitles
    }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Subtitles] Subtitle cache write error (ignoring for serverless):', err.message);
  }

  return {
    success: true,
    videoId,
    subtitles: formattedSubtitles
  };
}));

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
    const isFresh = req.query.fresh === '1';
    const cacheKey = u.href;
    const hit = isFresh ? null : imgCache.get(cacheKey);
    if (hit) {
      if (detectImageType(hit.body)) {
        res.set({ 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400' });
        return res.send(hit.body);
      }
      imgCache.delete(cacheKey);
    }

    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    let type = r.headers.get('content-type') || '';
    let body = Buffer.from(await r.arrayBuffer());
    if (!r.ok) {
      res.set({ 'Cache-Control': 'no-store' });
      return res.status(404).send(`upstream ${r.status} ${type}`);
    }
    if (isHeic(body) || /hei[cf]/i.test(type)) {
      await acquire();
      try { body = Buffer.from(await convert({ buffer: body, format: 'JPEG', quality: 0.8 })); type = 'image/jpeg'; }
      finally { release(); }
    } else {
      let det = detectImageType(body);
      if (!det) {
        // Attempt Yeguo media AES-CBC decryption
        const decrypted = decryptYeguoMedia(body);
        if (decrypted) {
          const decType = detectImageType(decrypted);
          if (decType) {
            body = decrypted;
            det = decType;
          }
        }
      }
      if (det) {
        type = det;
      } else {
        // Neither raw nor decrypted buffer is a valid image; do not send corrupt bytes!
        res.set({ 'Cache-Control': 'no-store' });
        return res.status(404).send(`upstream not an image: ${type}`);
      }
    }
    const out = { type, body };
    if (imgCache.size > 600) imgCache.delete(imgCache.keys().next().value);
    imgCache.set(cacheKey, out);
    res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
    res.send(body);
  } catch (e) {
    res.set({ 'Cache-Control': 'no-store' });
    res.status(502).send(String(e.message || e));
  }
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
