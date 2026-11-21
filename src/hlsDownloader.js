// Pure client-side HLS decrypter and downloader
// Seamlessly downloads and decrypts HLS AES-128 streams directly in the browser!
// Zero server load, zero Vercel timeout issues, no FFmpeg binary required.

function hexToUint8Array(hex) {
  const clean = hex.replace(/^0x/i, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function fetchAndDecryptHls(m3u8Url, onProgress = () => {}, signal = null) {
  if (signal?.aborted) throw new Error('Download aborted');

  const res = await fetch(m3u8Url, { signal });
  if (!res.ok) throw new Error(`Failed to load playlist (${res.status})`);
  const text = await res.text();
  const lines = text.split(/\r?\n/);

  let currentKey = null;
  let currentIv = null;
  const segments = [];
  let segIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-KEY:')) {
      const uriMatch = trimmed.match(/URI=["']([^"']+)["']/i);
      const ivMatch = trimmed.match(/IV=0x([0-9a-fA-F]+)/i);
      if (uriMatch) {
        const keyUrl = new URL(uriMatch[1], m3u8Url).href;
        const keyRes = await fetch(keyUrl, { signal });
        if (!keyRes.ok) throw new Error(`Failed to fetch decryption key (${keyRes.status})`);
        const keyBuf = await keyRes.arrayBuffer();
        currentKey = await window.crypto.subtle.importKey(
          'raw',
          keyBuf,
          { name: 'AES-CBC' },
          false,
          ['decrypt']
        );
      }
      if (ivMatch) {
        currentIv = hexToUint8Array(ivMatch[1]);
      } else {
        currentIv = null;
      }
    } else if (trimmed && !trimmed.startsWith('#')) {
      const segUrl = new URL(trimmed, m3u8Url).href;
      segments.push({
        url: segUrl,
        key: currentKey,
        iv: currentIv,
        index: segIndex++,
      });
    }
  }

  if (!segments.length) {
    throw new Error('No video segments found in playlist');
  }

  // 6 parallel connections offers the fastest throughput without saturating mobile connections
  const CONCURRENCY = 6;
  const decryptedChunks = new Array(segments.length);
  let completed = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  onProgress({
    current: 0,
    total: segments.length,
    percent: 0,
    speedMBs: '0.0',
    loadedMB: '0.0',
  });

  async function processSegment(idx) {
    if (signal?.aborted) throw new Error('Download aborted');
    const seg = segments[idx];
    const segRes = await fetch(seg.url, { signal });
    if (!segRes.ok) throw new Error(`Failed segment ${idx + 1} (${segRes.status})`);
    const encBuf = await segRes.arrayBuffer();

    if (seg.key) {
      let segIv = seg.iv;
      if (!segIv) {
        segIv = new Uint8Array(16);
        const view = new DataView(segIv.buffer);
        view.setUint32(12, seg.index, false);
      }
      const dec = await window.crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: segIv },
        seg.key,
        encBuf
      );
      decryptedChunks[idx] = dec;
      totalBytes += dec.byteLength;
    } else {
      decryptedChunks[idx] = encBuf;
      totalBytes += encBuf.byteLength;
    }

    completed++;
    const elapsedSec = Math.max(0.2, (Date.now() - startTime) / 1000);
    const speedMBs = ((totalBytes / (1024 * 1024)) / elapsedSec).toFixed(1);
    const loadedMB = (totalBytes / (1024 * 1024)).toFixed(1);

    onProgress({
      current: completed,
      total: segments.length,
      percent: Math.round((completed / segments.length) * 100),
      speedMBs,
      loadedMB,
    });
  }

  let queueIndex = 0;
  async function worker() {
    while (queueIndex < segments.length) {
      if (signal?.aborted) throw new Error('Download aborted');
      const idx = queueIndex++;
      await processSegment(idx);
    }
  }

  const workerCount = Math.min(CONCURRENCY, segments.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return new Blob(decryptedChunks, { type: 'video/mp4' });
}
