import { useEffect, useRef, useState, useMemo } from 'react';
import Hls from 'hls.js';

function formatVttTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const remS = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export default function VideoPlayer({
  src,
  poster,
  onEnded,
  autoPlay = true,
  onError,
  subtitles = [],
  subtitleOffset = 0,
  onSubtitleOffsetChange,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [playerError, setPlayerError] = useState('');

  // Subtitle states
  const [showSubtitles, setShowSubtitles] = useState(() => {
    const saved = localStorage.getItem('hg_show_subtitles');
    return saved !== null ? saved === 'true' : true;
  });
  const [subFontSize, setSubFontSize] = useState(() => {
    return localStorage.getItem('hg_sub_font_size') || 'md'; // sm, md, lg
  });
  const [currentCue, setCurrentCue] = useState(null);
  const [showSubSettings, setShowSubSettings] = useState(false);

  const toggleSubtitles = () => {
    setShowSubtitles((prev) => {
      const next = !prev;
      localStorage.setItem('hg_show_subtitles', String(next));
      return next;
    });
  };

  const cycleFontSize = () => {
    setSubFontSize((prev) => {
      const next = prev === 'sm' ? 'md' : prev === 'md' ? 'lg' : 'sm';
      localStorage.setItem('hg_sub_font_size', next);
      return next;
    });
  };

  const adjustOffset = (delta) => {
    if (onSubtitleOffsetChange) {
      onSubtitleOffsetChange(+((subtitleOffset + delta).toFixed(1)));
    }
  };

  // Generate WebVTT for native track support
  const vttBlobUrl = useMemo(() => {
    if (!subtitles || !subtitles.length) return null;
    let vtt = 'WEBVTT\n\n';
    subtitles.forEach((s, idx) => {
      const sStart = Math.max(0, s.start + subtitleOffset);
      const sEnd = Math.max(sStart + 0.3, s.end + subtitleOffset);
      vtt += `${idx + 1}\n${formatVttTime(sStart)} --> ${formatVttTime(sEnd)}\n${s.text}\n\n`;
    });
    const blob = new Blob([vtt], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    return url;
  }, [subtitles, subtitleOffset]);

  useEffect(() => {
    return () => {
      if (vttBlobUrl) {
        URL.revokeObjectURL(vttBlobUrl);
      }
    };
  }, [vttBlobUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    setIsLoading(true);
    setPlayerError('');
    setCurrentCue(null);

    // Teardown previous HLS instance if any
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isHls = /\.m3u8/i.test(src) || src.includes('yeguo') || src.includes('huangguo') || src.includes('stream');

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
      });
      hlsRef.current = hls;

      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setIsLoading(false);
        if (autoPlay) {
          video.play().catch((e) => {
            console.warn('[VideoPlayer] Autoplay prevented by browser:', e.message);
          });
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.warn('[VideoPlayer] Fatal HLS error:', data.type, data.details);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.warn('[VideoPlayer] Recovering network error...');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.warn('[VideoPlayer] Recovering media error...');
              hls.recoverMediaError();
              break;
            default:
              console.error('[VideoPlayer] Unrecoverable HLS error');
              setPlayerError('Playback error. Please try clicking another episode or reloading.');
              hls.destroy();
              if (onError) onError(data);
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl') && isHls) {
      // Native HLS for Safari (iOS & macOS)
      video.src = src;
      const onLoaded = () => {
        setIsLoading(false);
        if (autoPlay) {
          video.play().catch(() => {});
        }
      };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
    } else {
      // Standard MP4 / WebM
      video.src = src;
      const onLoaded = () => {
        setIsLoading(false);
        if (autoPlay) {
          video.play().catch(() => {});
        }
      };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
    }

    const handleWaiting = () => setIsLoading(true);
    const handlePlaying = () => setIsLoading(false);
    const handleCanPlay = () => setIsLoading(false);

    // Synchronize subtitle display with current playback time
    const handleTimeUpdate = () => {
      if (!subtitles || !subtitles.length || !showSubtitles) {
        if (currentCue) setCurrentCue(null);
        return;
      }
      const cur = video.currentTime;
      const match = subtitles.find((s) => {
        const start = s.start + subtitleOffset;
        const end = s.end + subtitleOffset;
        return cur >= start && cur <= end;
      });
      setCurrentCue(match || null);
    };

    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [src, autoPlay, onError, subtitles, showSubtitles, subtitleOffset]);

  const hasSubtitles = subtitles && subtitles.length > 0;

  return (
    <div className="video-player-container" style={{ position: 'relative', width: '100%', background: '#000', borderRadius: '10px', overflow: 'hidden' }}>
      <video
        ref={videoRef}
        poster={poster}
        controls
        playsInline
        onEnded={onEnded}
        style={{
          width: '100%',
          maxHeight: '65vh',
          display: 'block',
          background: '#000',
          margin: '0 auto',
          objectFit: 'contain',
        }}
      >
        {vttBlobUrl && (
          <track
            kind="subtitles"
            src={vttBlobUrl}
            srcLang="km"
            label="Khmer"
            default={showSubtitles}
          />
        )}
      </video>

      {/* Floating Subtitle Controls Header */}
      {hasSubtitles && (
        <div className="player-sub-toolbar">
          <button
            type="button"
            className={`sub-pill-btn ${showSubtitles ? 'active' : ''}`}
            onClick={toggleSubtitles}
            title={showSubtitles ? 'Disable Khmer Subtitles' : 'Enable Khmer Subtitles'}
          >
            <span>CC</span>
            <span>{showSubtitles ? '🇰🇭 ON' : 'OFF'}</span>
          </button>

          {showSubtitles && (
            <button
              type="button"
              className="sub-pill-btn alt"
              onClick={() => setShowSubSettings((v) => !v)}
              title="Subtitle Settings (Sync & Size)"
            >
              <span>⚙️</span>
              {subtitleOffset !== 0 && <small>{subtitleOffset > 0 ? `+${subtitleOffset}s` : `${subtitleOffset}s`}</small>}
            </button>
          )}

          {showSubtitles && showSubSettings && (
            <div className="sub-settings-popover">
              <div className="sub-setting-row">
                <span>ទំហំអក្សរ (Size):</span>
                <button type="button" className="sub-mini-btn" onClick={cycleFontSize}>
                  {subFontSize === 'sm' ? 'A (តូច)' : subFontSize === 'md' ? 'A+ (មធ្យម)' : 'A++ (ធំ)'}
                </button>
              </div>
              <div className="sub-setting-row">
                <span>តម្រឹមម៉ោង (Sync):</span>
                <div className="sub-sync-group">
                  <button type="button" className="sub-mini-btn" onClick={() => adjustOffset(-0.5)}>-0.5s</button>
                  <button type="button" className="sub-mini-btn" onClick={() => onSubtitleOffsetChange?.(0)}>Reset</button>
                  <button type="button" className="sub-mini-btn" onClick={() => adjustOffset(0.5)}>+0.5s</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Responsive Khmer Subtitle Overlay */}
      {showSubtitles && currentCue && (
        <div className="v-subtitle-overlay" aria-live="polite">
          <div className={`v-subtitle-box font-${subFontSize}`}>
            <span className="v-subtitle-text">{currentCue.text}</span>
            {currentCue.original && (
              <span className="v-subtitle-original">{currentCue.original}</span>
            )}
          </div>
        </div>
      )}

      {isLoading && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            background: 'rgba(0, 0, 0, 0.65)',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: '20px',
            fontSize: '13px',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            zIndex: 10,
          }}
        >
          <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⏳</span>
          <span>Loading stream…</span>
        </div>
      )}

      {playerError && (
        <div
          style={{
            position: 'absolute',
            bottom: '16px',
            left: '16px',
            right: '16px',
            background: 'rgba(239, 68, 68, 0.9)',
            color: '#fff',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            textAlign: 'center',
            zIndex: 10,
          }}
        >
          {playerError}
        </div>
      )}
    </div>
  );
}
