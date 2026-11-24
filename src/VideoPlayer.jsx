import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export default function VideoPlayer({
  src,
  poster,
  onEnded,
  autoPlay = true,
  onError,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [playerError, setPlayerError] = useState('');

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    setIsLoading(true);
    setPlayerError('');

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

    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handleCanPlay);

    return () => {
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('canplay', handleCanPlay);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [src, autoPlay, onError]);

  return (
    <div style={{ position: 'relative', width: '100%', background: '#000', borderRadius: '10px', overflow: 'hidden' }}>
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
        }}
      />
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
          }}
        >
          {playerError}
        </div>
      )}
    </div>
  );
}
