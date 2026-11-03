import { useState, useRef, useEffect, useMemo } from 'react';
import AdBanner from './AdBanner';
import { LANGUAGES, GENRES, t, getGenre } from './i18n';
import { translateText, translateBatch } from './translateService';

const PAGE_SIZE = 24;  // Reveal 24 dramas at a time
const MAX = 1000;       // hard cap (server enforces too)

const api = async (url, body) => {
  const r = await fetch(url, body && {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    if (!r.ok) {
      throw new Error(`Server ${r.status}: ${text.slice(0, 150)}`);
    }
    throw new Error('Invalid JSON response from server');
  }
  if (!r.ok) throw new Error(j.error || `Request failed with status ${r.status}`);
  return j;
};

const dig = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const pick = (o, ...paths) => {
  for (const p of paths) { const v = dig(o, p); if (v != null && v !== '') return v; }
};

// ---- cover helpers -------------------------------------------------------
const IMG_KEY = /cover|thumb|poster|pic|image|img/i;
function toUrl(v) {
  if (typeof v === 'string')
    return /^(https?:)?\/\//.test(v) ? v.replace(/^\/\//, 'https://').replace(/^http:/, 'https:') : null;
  if (Array.isArray(v)) return toUrl(v[0]);
  if (v && typeof v === 'object') return toUrl(v.url_list ?? v.url ?? v.uri);
  return null;
}
function findCover(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(o)) if (IMG_KEY.test(k)) { const u = toUrl(v); if (u) return u; }
  for (const v of Object.values(o))
    if (v && typeof v === 'object') { const u = findCover(v, depth + 1); if (u) return u; }
  return null;
}

// Covers are HEIC; the server proxy converts them to JPEG.
const variants = (src) => {
  const proxied = `/api/img?u=${encodeURIComponent(src)}`;
  return /\.hei[cf]/i.test(src) ? [proxied] : [src, proxied];
};
function Cover({ src }) {
  const [stage, setStage] = useState(0);
  const [why, setWhy] = useState('');
  useEffect(() => setStage(0), [src]);
  const list = src ? variants(src) : [];
  const failed = !src || stage >= list.length;
  useEffect(() => {
    if (!src || !failed) return;
    api(`/api/imgcheck?u=${encodeURIComponent(src)}`)
      .then((d) => setWhy(d.error ? `error: ${d.error}` : `${d.status} ${d.type || ''} .${d.ext}`))
      .catch(() => setWhy('diagnostic route missing: restart server'));
  }, [failed, src]);
  if (failed)
    return (
      <div className="ph" title={src || 'no cover URL in data'}>
        <span>{src ? 'Cover failed' : 'No cover'}<br /><small>{why}</small></span>
      </div>
    );
  return (
    <img src={list[stage]} referrerPolicy="no-referrer" alt="" loading="lazy"
      onError={() => setStage((s) => s + 1)} />
  );
}

// ---- data normalisation --------------------------------------------------
function toTags(v) {
  if (!v) return [];
  if (typeof v === 'string') return v.split(/[,，、|\s]+/).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap((t) => (typeof t === 'string' ? toTags(t) : toTags(t?.name ?? t?.tag ?? t?.title ?? t?.text)));
  return [];
}
const TAG_KEYS = ['recommendReasons', 'tags', 'categories', 'category', 'genre', 'raw.tags', 'raw.series_tags', 'raw.category', 'raw.categories'];

function normalize(item) {
  const d = item.data || item;
  const v = d.video_data?.[0] || d;
  return {
    id: String(pick(v, 'series_id', 'seriesId', 'book_id', 'id') ?? pick(d, 'series_id', 'seriesId') ?? ''),
    title: pick(v, 'series_name', 'title', 'series.title', 'name', 'book_name') || 'Untitled',
    cover: findCover(v) || findCover(d),
    episodes: pick(v, 'episode_cnt', 'episodeCount', 'series.episodeCount', 'series_count'),
    desc: pick(v, 'series_intro', 'intro', 'synopsis', 'series.synopsis', 'introduction', 'desc'),
    tags: [...new Set(TAG_KEYS.flatMap((k) => toTags(dig(v, k))))].slice(0, 8),
  };
}

// ---- main app ------------------------------------------------------------
export default function App() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('hg_theme');
    if (saved) return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('hg_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const [lang, setLang] = useState(() => localStorage.getItem('hg_app_lang') || 'km');
  const [titles, setTitles] = useState({});
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [hasMoreServer, setHasMoreServer] = useState(true);
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('home'); // 'home' | 'search'
  const [cat, setCat] = useState('All');
  const [apifyStatus, setApifyStatus] = useState(null);
  const [dismissAlert, setDismissAlert] = useState(false);

  const toCards = (items) => {
    const seen = new Set();
    return items.filter((i) => i.success !== false).map(normalize)
      .filter((r) => r.id && !seen.has(r.id) && seen.add(r.id));
  };

  function explain(items, cards) {
    if (cards.length) return '';
    const d = items.find((i) => i.success === false) || items[0] || {};
    if (d.errorCode === 'FREE_TIER_MONTHLY_QUOTA_REACHED')
      return t('quotaError', lang);
    if (d.error) return `Apify actor error: ${d.error}`;
    return items.length
      ? `Got ${items.length} items but could not read series IDs. Open "Raw first result" below and send it to fix the field mapping.`
      : 'No results returned.';
  }

  async function loadHome() {
    setLoading(true); setError(''); setMode('home'); setCat('All');
    setVisibleCount(PAGE_SIZE);
    setHasMoreServer(true);
    try {
      const items = await api('/api/home?limit=200');
      setRaw(items[0] || null);
      const cards = toCards(items);
      setResults(cards);
      setError(explain(items, cards));
    } catch (err) { setError(err.message); }
    setLoading(false);
  }

  useEffect(() => {
    loadHome();
    fetch('/api/apify-status')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.limitExceeded) setApifyStatus(d);
      })
      .catch(() => { });
  }, []);

  async function loadMore() {
    if (loading) return;

    // 1. Reveal more cards already loaded in memory
    if (hasMoreToReveal) {
      setVisibleCount((prev) => prev + PAGE_SIZE);
      return;
    }

    // 2. If all in-memory cards are shown, fetch more from the server
    if (canLoadMoreFromServer) {
      setLoading(true);
      setError('');
      try {
        const nextLimit = results.length + PAGE_SIZE;
        const items = await api(`/api/home?limit=${nextLimit}`);
        const cards = toCards(items);
        if (cards.length > results.length) {
          setResults(cards);
          setVisibleCount((prev) => prev + PAGE_SIZE);
        } else {
          setHasMoreServer(false);
        }
      } catch (err) {
        setError(err.message);
      }
      setLoading(false);
    }
  }

  async function runSearch(q) {
    setMode('search'); setCat('All'); setLoading(true); setError(''); setSelected(null);
    setVisibleCount(PAGE_SIZE);
    try {
      const items = await api('/api/search', { query: q, maxPages: 3 });
      setRaw(items.find((i) => i.success !== false) || items[0] || null);
      const cards = toCards(items);
      setResults(cards);
      setError(explain(items, cards));
    } catch (err) { setError(err.message); }
    setLoading(false);
  }

  async function search(e) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return loadHome();

    // If query has no Chinese characters and user is in Khmer/English, translate to Chinese for Hongguo search
    const hasChinese = /[\u4e00-\u9fa5]/.test(q);
    if (!hasChinese && lang !== 'zh-CN') {
      setLoading(true);
      try {
        const zh = await translateText(q, 'zh-CN', 'auto');
        if (zh && zh.trim() !== q) {
          return runSearch(zh.trim());
        }
      } catch (err) {
        console.warn('Search translation error:', err);
      }
    }
    runSearch(q);
  }
  function pickGenre(g) { setQuery(g); runSearch(g); }

  const counts = useMemo(() => {
    const c = {};
    results.forEach((r) => r.tags.forEach((t) => { c[t] = (c[t] || 0) + 1; }));
    return c;
  }, [results]);
  const tagList = Object.keys(counts).sort((x, y) => counts[y] - counts[x]).slice(0, 24);

  const filteredResults = useMemo(() => {
    if (cat === 'All') return results;
    return results.filter((r) => r.tags.includes(cat));
  }, [results, cat]);

  const shown = useMemo(() => {
    return filteredResults.slice(0, visibleCount);
  }, [filteredResults, visibleCount]);

  const hasMoreToReveal = visibleCount < filteredResults.length;
  const canLoadMoreFromServer = mode === 'home' && hasMoreServer && cat === 'All';
  const canLoadMore = hasMoreToReveal || canLoadMoreFromServer;
  const remainingCount = hasMoreToReveal
    ? Math.min(filteredResults.length - visibleCount, PAGE_SIZE)
    : PAGE_SIZE;

  // Translate drama titles using Google Translate when not Chinese
  useEffect(() => {
    if (lang === 'zh-CN' || !shown.length) return;

    const needed = shown.filter((r) => r.title && !titles[`${lang}_${r.id}`]);
    if (!needed.length) return;

    const list = needed.slice(0, 50);
    let active = true;

    translateBatch(list.map((r) => r.title), lang, 'zh-CN').then((translated) => {
      if (!active) return;
      setTitles((prev) => {
        const next = { ...prev };
        list.forEach((r, idx) => {
          next[`${lang}_${r.id}`] = translated[idx] || r.title;
        });
        return next;
      });
    });

    return () => { active = false; };
  }, [shown, lang, titles]);

  const isLimitExceeded = Boolean(
    apifyStatus?.limitExceeded ||
    (error && (error.includes('hard limit') || error.includes('403') || error.includes('Monthly usage') || error.includes('platform-feature-disabled')))
  );

  const handleLangChange = (codeOrEvent) => {
    const val = typeof codeOrEvent === 'string' ? codeOrEvent : codeOrEvent?.target?.value;
    if (val) {
      setLang(val);
      localStorage.setItem('hg_app_lang', val);
    }
  };

  return (
    <main>
      {/* Top Banner Placement 
      <div className="ad-container" style={{ margin: '20px 0' }}>
        <AdBanner />
      </div>*/}

      <div className="top">
        <div className="app-brand" onClick={() => loadHome()} style={{ cursor: 'pointer' }} title={t('appTitle', lang)}>
          <img
            src="/icon.svg"
            alt="Hongguo App Logo"
            className="app-logo"
            width="42"
            height="42"
          />
          <h1>{t('appTitle', lang)}</h1>
        </div>
        <div className="top-actions">
          <div className="lang-flags" role="group" aria-label="Language selection">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                className={`lang-flag-btn ${lang === l.code ? 'active' : ''}`}
                onClick={() => handleLangChange(l.code)}
                title={l.name}
                aria-label={l.name}
              >
                {l.flag}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="theme-toggle-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            )}
          </button>
        </div>
      </div>

      <form onSubmit={search} className="search-box-wrapper">
        <div className="search-icon-left" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </div>
        <input
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder', lang)}
        />
        {query && (
          <button
            type="button"
            className="clear-btn"
            onClick={() => setQuery('')}
            title="Clear"
            aria-label="Clear"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        )}
        <button type="submit" className="search-btn" disabled={loading}>
          {loading ? (
            <>
              <svg className="spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="16" height="16">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeLinecap="round"></circle>
              </svg>
              <span>{t('searching', lang)}</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <span>{t('searchBtn', lang)}</span>
            </>
          )}
        </button>
      </form>

      <div className="chips">
        <small>{t('genresLabel', lang)}</small>
        {GENRES.map((g) => <button key={g} className="chip" onClick={() => pickGenre(g)}>{getGenre(g, lang)}</button>)}
      </div>

      {isLimitExceeded && !dismissAlert && (
        <div className="apify-banner">
          <div className="apify-banner-header">
            <span className="apify-banner-icon">⚠️</span>
            <div className="apify-banner-title">
              <strong>{t('apifyLimitTitle', lang)}</strong>
              <p>{t('apifyLimitNotice', lang)}</p>
            </div>
            <button
              type="button"
              className="apify-banner-dismiss"
              onClick={() => setDismissAlert(true)}
              title={t('dismiss', lang)}
            >
              ✕
            </button>
          </div>
          <div className="apify-banner-steps">
            <div className="apify-step">
              <span className="apify-step-num">1</span>
              <span>{t('apifyFixStep1', lang)}</span>
            </div>
            <div className="apify-step">
              <span className="apify-step-num">2</span>
              <span>{t('apifyFixStep2', lang)}</span>
            </div>
            <div className="apify-step">
              <span className="apify-step-num">3</span>
              <span>{t('apifyFixStep3', lang)}</span>
            </div>
          </div>
        </div>
      )}

      {error && !isLimitExceeded && <p className="err">{error}</p>}

      <h2 className="sec">
        {mode === 'home' ? `${t('allDramas', lang)} (${filteredResults.length})` : `${t('resultsFor', lang)} “${query}” (${filteredResults.length})`}
        {isLimitExceeded && results.length > 0 && (
          <span className="cached-badge">{t('offlineBadge', lang)}</span>
        )}
      </h2>
      {mode === 'search' && <button className="link" onClick={() => loadHome()}>{t('backHome', lang)}</button>}

      {tagList.length > 0 && (
        <div className="chips">
          {['All', ...tagList].map((tTag) => (
            <button key={tTag} className={'chip' + (cat === tTag ? ' on' : '')} onClick={() => { setCat(tTag); setVisibleCount(PAGE_SIZE); }}>
              {tTag === 'All' ? t('all', lang) : tTag}{tTag !== 'All' && ` ${counts[tTag]}`}
            </button>
          ))}
        </div>
      )}

      <div className="grid">
        {shown.map((r) => (
          <article key={r.id} className="card" onClick={() => setSelected(r)}>
            <div className="thumb">
              <Cover src={r.cover} />
              <div className="play-overlay"><span>▶</span></div>
              {r.episodes && <span className="ep-badge">{r.episodes} {t('episodes', lang)}</span>}
            </div>
            <h3>{lang === 'zh-CN' ? r.title : (titles[`${lang}_${r.id}`] || r.title)}</h3>
            <small>{r.episodes ? `${r.episodes} ${t('episodes', lang)}` : `ID ${r.id}`}</small>
          </article>
        ))}
      </div>

      {results.length > 0 && canLoadMore && (
        <div className="more">
          <button onClick={loadMore} disabled={loading}>
            {loading ? t('loading', lang) : t('loadMore', lang, { count: remainingCount })}
          </button>
        </div>
      )}
      {loading && !results.length && <p className="muted">{t('loading', lang)}</p>}

      {raw && (
        <details className="raw">
          <summary>{t('rawFirstResult', lang)}</summary>
          <pre>{JSON.stringify(raw, null, 2)}</pre>
        </details>
      )}

      {selected && <Detail series={selected} onClose={() => setSelected(null)} lang={lang} />}

      <footer>{t('footer', lang)}</footer>
    </main>
  );
}

// ---- detail view: cover, episodes, play, download ------------------------
const DONE = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];

function Detail({ series, onClose, lang }) {
  const [info, setInfo] = useState(null);
  const [ready, setReady] = useState({});     // videoId -> download item (has videoUrl)
  const [pending, setPending] = useState({}); // videoId -> true while Apify works
  const [failed, setFailed] = useState({});   // videoId -> error text
  const [sel, setSel] = useState(() => new Set());
  const [playing, setPlaying] = useState(null); // { ep, item }
  const [error, setError] = useState('');
  const timers = useRef([]);

  // One-click batch download states
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadQueue, setDownloadQueue] = useState([]);
  const [downloadIndex, setDownloadIndex] = useState(0);
  const [downloadedSet, setDownloadedSet] = useState(() => new Set());
  const [statusMessage, setStatusMessage] = useState('');
  const [copiedLinks, setCopiedLinks] = useState(false);

  const cancelDownloadRef = useRef(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const failedRef = useRef(failed);
  failedRef.current = failed;

  // Translated title & synopsis
  const [transTitle, setTransTitle] = useState('');
  const [transDesc, setTransDesc] = useState('');

  useEffect(() => {
    api(`/api/series/${series.id}`)
      .then((r) => {
        const row = r.find((x) => x.success !== false) || r[0];
        if (!row || row.success === false)
          setError(row?.errorCode === 'FREE_TIER_MONTHLY_QUOTA_REACHED'
            ? t('quotaError', lang)
            : row?.error || 'Could not load series details.');
        else setInfo(row);
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelDownloadRef.current = true;
      timers.current.forEach(clearInterval);
    };
  }, [series.id, lang]);

  const s = info?.series || {};
  const rawTitle = s.title || series.title;
  const rawDesc = s.synopsis || series.desc || '';
  const cover = (info?.series && findCover(info.series)) || series.cover;

  useEffect(() => {
    if (lang === 'zh-CN') return;
    let active = true;
    if (rawTitle) {
      translateText(rawTitle, lang, 'zh-CN').then((tr) => { if (active) setTransTitle(tr); });
    }
    if (rawDesc) {
      translateText(rawDesc, lang, 'zh-CN').then((tr) => { if (active) setTransDesc(tr); });
    }
    return () => { active = false; };
  }, [rawTitle, rawDesc, lang]);

  const title = (lang !== 'zh-CN' && transTitle) ? transTitle : rawTitle;
  const desc = (lang !== 'zh-CN' && transDesc) ? transDesc : rawDesc;

  const eps = useMemo(() => {
    const e = info?.episodes || [];
    if (e.length) return e;
    return s.firstVideoId ? [{ videoId: s.firstVideoId, episodeIndex: '1' }] : [];
  }, [info, s.firstVideoId]);
  const label = (ep, n) => `${t('ep', lang)} ${ep.episodeIndex ?? n + 1}`;

  function clearPending(ids) {
    setPending((p) => { const n = { ...p }; ids.forEach((i) => delete n[i]); return n; });
  }

  async function prepare(list) {
    const ids = list.map(String).filter((id) => !readyRef.current[id]?.videoUrl && !pendingRef.current[id]);
    if (!ids.length) return;
    setError('');
    setFailed((f) => { const n = { ...f }; ids.forEach((i) => delete n[i]); return n; });
    setPending((p) => ({ ...p, ...Object.fromEntries(ids.map((i) => [i, true])) }));

    const chunkSize = 80;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      try {
        const { runId } = await api('/api/download', { videoIds: chunk });
        const t = setInterval(async () => {
          try {
            const st = await api(`/api/download/${runId}`);
            const ok = {}, bad = {};
            st.items.forEach((item) => {
              if (item.success && item.videoUrl) ok[String(item.videoId)] = item;
              else if (item.videoId) bad[String(item.videoId)] = item.error || 'failed';
            });
            setReady((r) => ({ ...r, ...ok }));
            if (st.done || DONE.includes(st.status)) {
              clearInterval(t);
              setFailed((f) => ({ ...f, ...bad }));
              clearPending(chunk);
              const quota = st.items.find((item) => item.errorCode);
              if (quota) setError(quota.error || `Apify: ${quota.errorCode}`);
              else if (!Object.keys(ok).length && !Object.keys(bad).length) setError(`Run ${st.status} with no videos.`);
            }
          } catch (e) { clearInterval(t); setError(e.message); clearPending(chunk); }
        }, 3000);
        timers.current.push(t);
      } catch (e) { setError(e.message); clearPending(chunk); }
    }
  }

  function prepareMany(ids) {
    const n = ids.filter((id) => !ready[id] && !pending[id]).length;
    if (!n) return;
    const cost = (n * 0.0035).toFixed(2);
    if (n > 5 && !window.confirm(t('confirmPrepare', lang, { count: n, cost }))) return;
    prepare(ids);
  }

  const toggle = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const fileUrl = (item, ep, n) =>
    `/api/file?u=${encodeURIComponent(item.videoUrl)}&name=${encodeURIComponent(`${title} ${label(ep, n)}`)}`;
  const busy = Object.keys(pending).length;
  const readyCount = eps.filter((e) => ready[String(e.videoId)]?.videoUrl).length;
  const nextReady = playing && eps.slice(eps.indexOf(playing.ep) + 1).find((e) => ready[String(e.videoId)]);
  const playNext = () => nextReady && setPlaying({ ep: nextReady, item: ready[String(nextReady.videoId)] });

  const triggerSingleFileDownload = (url, filename) => {
    const a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', filename);
    a.setAttribute('target', '_blank');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        document.body.removeChild(a);
      } catch {}
    }, 2500);
  };

  const waitForReady = async (id) => {
    const startTime = Date.now();
    while (!cancelDownloadRef.current && Date.now() - startTime < 180000) {
      if (readyRef.current[id]?.videoUrl) {
        return readyRef.current[id];
      }
      if (failedRef.current[id]) {
        return null;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return readyRef.current[id] || null;
  };

  const startOneClickDownload = async (targetList) => {
    if (!targetList || !targetList.length || isDownloading) return;

    cancelDownloadRef.current = false;
    setIsDownloading(true);
    setDownloadQueue(targetList);
    setDownloadIndex(0);
    setError('');

    // Trigger preparation for unready episodes
    const unreadyIds = targetList
      .map((e) => String(e.videoId))
      .filter((id) => !readyRef.current[id]?.videoUrl && !pendingRef.current[id]);

    if (unreadyIds.length > 0) {
      prepare(unreadyIds);
    }

    // Process sequential downloads
    for (let i = 0; i < targetList.length; i++) {
      if (cancelDownloadRef.current) break;

      setDownloadIndex(i);
      const ep = targetList[i];
      const id = String(ep.videoId);
      const epIndex = eps.indexOf(ep);
      const epLabel = label(ep, epIndex >= 0 ? epIndex : i);

      let item = readyRef.current[id];
      if (!item || !item.videoUrl) {
        setStatusMessage(t('waitingForEp', lang, { ep: epLabel }));
        item = await waitForReady(id);
      }

      if (cancelDownloadRef.current) break;

      if (item && item.videoUrl) {
        setStatusMessage(t('downloadingEp', lang, { ep: epLabel }));
        const fileName = `${title} ${epLabel}`;
        const url = fileUrl(item, ep, epIndex >= 0 ? epIndex : i);
        triggerSingleFileDownload(url, `${fileName}.mp4`);
        setDownloadedSet((prev) => new Set([...prev, id]));
        await new Promise((r) => setTimeout(r, 1200));
      } else {
        console.warn(`Could not download ${epLabel}`);
      }
    }

    setIsDownloading(false);
    setStatusMessage('');
  };

  const cancelDownload = () => {
    cancelDownloadRef.current = true;
    setIsDownloading(false);
    setStatusMessage('');
  };

  const copyAllLinks = () => {
    const readyEps = eps.filter((ep) => ready[String(ep.videoId)]?.videoUrl);
    if (!readyEps.length) return;

    const domain = window.location.origin;
    const lines = readyEps.map((ep, idx) => {
      const id = String(ep.videoId);
      const item = ready[id];
      return `${domain}${fileUrl(item, ep, idx)}`;
    });

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopiedLinks(true);
      setTimeout(() => setCopiedLinks(false), 3000);
    });
  };

  return (
    <div className="overlay" onClick={onClose}>
      <section className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose}>✕</button>

        {playing && (
          <div className="player">
            <video key={playing.item.videoUrl} src={playing.item.videoUrl} poster={findCover(playing.ep) || cover}
              controls autoPlay playsInline onEnded={playNext} />
            <p className="row">
              <strong>{title} · {label(playing.ep, eps.indexOf(playing.ep))}</strong>
              <a className="btn" href={fileUrl(playing.item, playing.ep, eps.indexOf(playing.ep))}>{t('download', lang)}</a>
              {nextReady && <button className="mini" onClick={playNext}>{t('nextEp', lang)}</button>}
              <button className="mini alt" onClick={() => setPlaying(null)}>{t('closePlayer', lang)}</button>
            </p>
            <small className="muted">{playing.item.definition} · {playing.item.codec}. {t('vlcHint', lang)}</small>
          </div>
        )}

        <div className="head">
          <div className="thumb big"><Cover src={cover} /></div>
          <div>
            <h2>{title}</h2>
            {info?.isFallback && (
              <span className="cached-badge mini">{t('offlineBadge', lang)}</span>
            )}
            <p className="muted">{desc}</p>
            <p className="muted">
              {info ? `${s.episodeCount || eps.length} ${t('episodes', lang)}` : error ? '' : t('loadingDetails', lang)}
              {s.playCount ? ` · ${s.playCount} ${t('plays', lang)}` : ''}
            </p>
          </div>
        </div>

        {eps.length > 0 && (
          <div className="detail-actions-panel">
            <div className="primary-actions-row">
              <button
                type="button"
                className="btn-download-all"
                onClick={() => startOneClickDownload(eps)}
                disabled={isDownloading}
                title={t('oneClickDownloadAll', lang, { count: eps.length })}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span>{t('oneClickDownloadAll', lang, { count: eps.length })}</span>
              </button>

              {sel.size > 0 && (
                <button
                  type="button"
                  className="btn-download-selected"
                  onClick={() => startOneClickDownload(eps.filter((e) => sel.has(String(e.videoId))))}
                  disabled={isDownloading}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  <span>{t('downloadSelected', lang, { count: sel.size })}</span>
                </button>
              )}
            </div>

            <div className="secondary-actions-row">
              <div className="selection-buttons">
                <button
                  type="button"
                  className="mini-chip"
                  onClick={() => setSel(new Set(eps.map((e) => String(e.videoId))))}
                >
                  {t('selectAll', lang)}
                </button>
                <button
                  type="button"
                  className="mini-chip"
                  onClick={() => setSel(new Set(eps.slice(0, 10).map((e) => String(e.videoId))))}
                >
                  {t('selectFirst10', lang)}
                </button>
                {sel.size > 0 && (
                  <button
                    type="button"
                    className="mini-chip"
                    onClick={() => setSel(new Set())}
                  >
                    {t('deselectAll', lang)}
                  </button>
                )}
              </div>

              <div className="export-buttons">
                {readyCount > 0 && (
                  <button
                    type="button"
                    className="mini-chip outline"
                    onClick={copyAllLinks}
                    title="Copy direct video URLs"
                  >
                    {copiedLinks ? t('linksCopied', lang, { count: readyCount }) : t('exportLinks', lang, { count: readyCount })}
                  </button>
                )}
                {busy > 0 && (
                  <small className="muted busy-label">
                    <span className="spinner-dot"></span>
                    {t('workingOn', lang, { count: busy })}
                  </small>
                )}
              </div>
            </div>
          </div>
        )}

        {isDownloading && (
          <div className="download-progress-card">
            <div className="download-progress-header">
              <div className="download-progress-title">
                <span className="download-pulse-icon">📥</span>
                <div>
                  <strong>
                    {t('downloadingProgress', lang, {
                      current: Math.min(downloadIndex + 1, downloadQueue.length),
                      total: downloadQueue.length
                    })}
                  </strong>
                  <span className="download-current-desc">
                    {statusMessage || label(downloadQueue[downloadIndex], downloadIndex)}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="btn-stop-download"
                onClick={cancelDownload}
                title={t('stopDownload', lang)}
              >
                ✕ {t('stopDownload', lang)}
              </button>
            </div>

            <div className="download-bar-track">
              <div
                className="download-bar-fill"
                style={{
                  width: `${Math.round(((downloadIndex + 1) / Math.max(downloadQueue.length, 1)) * 100)}%`
                }}
              ></div>
            </div>

            <div className="download-progress-footer">
              <span>{Math.round(((downloadIndex + 1) / Math.max(downloadQueue.length, 1)) * 100)}% ({downloadIndex + 1}/{downloadQueue.length})</span>
              <span className="download-hint">{t('browserDownloadTip', lang)}</span>
            </div>
          </div>
        )}

        {info?.isFallback && (
          <div className="detail-fallback-notice">
            <span style={{ fontSize: '18px' }}>ℹ️</span>
            <div>
              <strong>{t('episodesLimitedNotice', lang)}</strong>
              <p>{t('episodesLimitedDesc', lang, { count: s.episodeCount || '?' })}</p>
            </div>
          </div>
        )}

        {eps.length === 0 && (
          <p className="muted" style={{ textAlign: 'center', padding: '24px 16px', background: 'var(--card)', borderRadius: '10px', border: '1px solid var(--border)', margin: '16px 0' }}>
            {t('noEpisodesNotice', lang)}
          </p>
        )}

        {error && (
          <p className="err">
            {error.includes('hard limit') || error.includes('403') || error.includes('Monthly usage')
              ? `${t('apifyLimitTitle', lang)}: ${t('apifyLimitNotice', lang)}`
              : error}
          </p>
        )}

        <div className="epgrid">
          {eps.map((ep, n) => {
            const id = String(ep.videoId);
            const r = ready[id];
            const isDownloaded = downloadedSet.has(id);
            const isCurrentlyDownloading = isDownloading && downloadQueue[downloadIndex]?.videoId === ep.videoId;

            return (
              <div key={id} className={'ep' + (sel.has(id) ? ' sel' : '') + (isDownloaded ? ' downloaded' : '')}>
                <div className="thumb" onClick={() => (r ? setPlaying({ ep, item: r }) : toggle(id))}>
                  <Cover src={findCover(ep) || cover} />
                  {isDownloaded && <span className="downloaded-badge">✓</span>}
                </div>
                <span>{label(ep, n)}{ep.duration ? ` · ${Math.round(ep.duration)}s` : ''}</span>
                {isCurrentlyDownloading ? (
                  <span className="ep-status-pill downloading">📥 {t('downloading', lang) || 'Downloading…'}</span>
                ) : isDownloaded ? (
                  <div className="row">
                    <span className="ep-status-pill done">✅ {t('saved', lang)}</span>
                    <button className="mini" onClick={() => setPlaying({ ep, item: r })}>▶</button>
                  </div>
                ) : r ? (
                  <div className="row">
                    <button className="mini" onClick={() => setPlaying({ ep, item: r })}>▶</button>
                    <a className="mini btn" href={fileUrl(r, ep, n)} title={t('download', lang)}>⬇</a>
                  </div>
                ) : pending[id] ? (
                  <small className="ep-status-pill pending">⏳ {t('preparing', lang)}</small>
                ) : failed[id] ? (
                  <small className="err" title={failed[id]}>Failed · <a href="#" onClick={(e) => { e.preventDefault(); prepare([id]); }}>retry</a></small>
                ) : (
                  <button className="mini alt" onClick={() => prepare([id])}>{t('getVideo', lang)}</button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
