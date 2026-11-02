// Client-side translation helper with Google Translate integration & caching

const memoryCache = new Map();

function getLocalCache(key) {
  try {
    const raw = localStorage.getItem('hg_trans_' + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setLocalCache(key, val) {
  try {
    localStorage.setItem('hg_trans_' + key, JSON.stringify(val));
  } catch {
    // Ignore storage quota errors
  }
}

export async function translateText(text, targetLang = 'en', sourceLang = 'auto') {
  if (!text || typeof text !== 'string') return text;
  const clean = text.trim();
  if (!clean) return text;

  const tl = targetLang === 'zh' ? 'zh-CN' : targetLang;
  const sl = sourceLang === 'zh' ? 'zh-CN' : sourceLang;
  if (sl === tl) return clean;

  const cacheKey = `${sl}_${tl}_${clean}`;
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);

  const stored = getLocalCache(cacheKey);
  if (stored) {
    memoryCache.set(cacheKey, stored);
    return stored;
  }

  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, targetLang: tl, sourceLang: sl }),
    });
    if (!res.ok) throw new Error('Translation failed');
    const data = await res.json();
    const result = data.translation || clean;
    memoryCache.set(cacheKey, result);
    setLocalCache(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('Translate error:', err);
    return clean;
  }
}

export async function translateBatch(texts, targetLang = 'en', sourceLang = 'auto') {
  if (!Array.isArray(texts) || !texts.length) return [];
  const tl = targetLang === 'zh' ? 'zh-CN' : targetLang;
  const sl = sourceLang === 'zh' ? 'zh-CN' : sourceLang;
  if (sl === tl) return texts;

  const missing = [];
  const results = new Array(texts.length);

  texts.forEach((text, i) => {
    if (!text || typeof text !== 'string') {
      results[i] = text;
      return;
    }
    const clean = text.trim();
    const cacheKey = `${sl}_${tl}_${clean}`;
    if (memoryCache.has(cacheKey)) {
      results[i] = memoryCache.get(cacheKey);
    } else {
      const stored = getLocalCache(cacheKey);
      if (stored) {
        memoryCache.set(cacheKey, stored);
        results[i] = stored;
      } else {
        missing.push({ index: i, text: clean, key: cacheKey });
      }
    }
  });

  if (!missing.length) return results;

  try {
    const toFetch = missing.map((m) => m.text);
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: toFetch, targetLang: tl, sourceLang: sl }),
    });
    if (res.ok) {
      const data = await res.json();
      const translations = data.translations || [];
      translations.forEach((tr, idx) => {
        const item = missing[idx];
        if (item) {
          const val = tr || item.text;
          results[item.index] = val;
          memoryCache.set(item.key, val);
          setLocalCache(item.key, val);
        }
      });
    } else {
      missing.forEach((item) => {
        results[item.index] = item.text;
      });
    }
  } catch (e) {
    console.warn('Batch translation warning:', e);
    missing.forEach((item) => {
      results[item.index] = item.text;
    });
  }

  return results;
}

