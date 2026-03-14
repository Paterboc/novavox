// MAIN world — intercept page data for subtitle tracks and media URLs (Netflix + YouTube)
(function () {
  'use strict';

  const _parse = JSON.parse;
  const hostname = location.hostname;
  const isNetflix = hostname.includes('netflix.com');
  const isYouTube = hostname.includes('youtube.com');

  // ── JSON.parse intercept ──

  JSON.parse = function (text, reviver) {
    const result = _parse.call(this, text, reviver);
    if (typeof text !== 'string') return result;

    try {
      if (isNetflix && text.includes('timedtexttracks')) {
        processNetflixParse(result);
      }
      if (isYouTube && (text.includes('captionTracks') || text.includes('streamingData'))) {
        processYouTubeParse(result);
      }
    } catch (err) {
      console.error('[NovaVox] JSON.parse intercept error:', err);
    }

    return result;
  };

  // ── Fetch intercept ──

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _fetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';

      if (isNetflix && (url.includes('manifest') || url.includes('metadata') || url.includes('shakti'))) {
        const clone = response.clone();
        clone.text().then((text) => {
          if (text.includes('timedtexttracks')) {
            try { processNetflixParse(_parse(text)); } catch (_) {}
          }
        });
      }

      if (isYouTube && url.includes('/youtubei/v1/player')) {
        const clone = response.clone();
        clone.json().then((data) => {
          try { processYouTubeParse(data); } catch (_) {}
        });
      }
    } catch (_) {}
    return response;
  };

  // ── YouTube: intercept initial player response ──

  if (isYouTube) {
    try {
      let _ytPR;
      Object.defineProperty(window, 'ytInitialPlayerResponse', {
        configurable: true,
        enumerable: true,
        get() { return _ytPR; },
        set(val) {
          _ytPR = val;
          try { processYouTubeParse(val); } catch (e) {
            console.error('[NovaVox] ytInitialPlayerResponse error:', e);
          }
        },
      });
    } catch (_) {
      // Fallback: poll
      const poll = setInterval(() => {
        if (window.ytInitialPlayerResponse) {
          try { processYouTubeParse(window.ytInitialPlayerResponse); } catch (_) {}
          clearInterval(poll);
        }
      }, 1000);
      setTimeout(() => clearInterval(poll), 30000);
    }
  }

  // ── Replay listeners ──

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.type === 'novavox_subs_replay' && window.__novavoxTracks) {
      window.postMessage({ type: 'novavox_subs', tracks: window.__novavoxTracks }, '*');
    }
    if (e.data?.type === 'novavox_media_replay' && window.__novavoxMedia) {
      window.postMessage({
        type: 'novavox_media',
        media: window.__novavoxMedia,
        title: window.__novavoxTitle || '',
      }, '*');
    }
  });

  // ═══════════════════════════════════════════════
  // Netflix
  // ═══════════════════════════════════════════════

  function processNetflixParse(result) {
    const allTracks = [];
    findTimedTextTracks(result, 0, allTracks);

    if (allTracks.length > 0) {
      console.log('[NovaVox] Raw timedtexttracks:', allTracks.length, 'tracks found');
      const payload = allTracks.map(normalizeNetflixTrack).filter(Boolean);
      console.log('[NovaVox] After normalize:', payload.length, 'usable tracks');
      if (payload.length > 0) {
        console.log('[NovaVox] Languages:', payload.map(t => t.displayName).join(', '));
        window.postMessage({ type: 'novavox_subs', tracks: payload }, '*');
        window.__novavoxTracks = payload;
      }
    }
  }

  function findTimedTextTracks(obj, depth, out) {
    if (!obj || typeof obj !== 'object' || depth > 6) return;

    if (Array.isArray(obj.timedtexttracks)) {
      for (const t of obj.timedtexttracks) {
        if (t && !t.isNoneTrack) out.push(t);
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        findTimedTextTracks(item, depth + 1, out);
      }
    } else {
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val && typeof val === 'object') {
          findTimedTextTracks(val, depth + 1, out);
        }
      }
    }
  }

  function normalizeNetflixTrack(track) {
    if (!track || track.isNoneTrack) return null;

    const bcp47 = track.language || track.bcp47 || '';
    const displayName =
      track.languageDescription ||
      track.language_description ||
      bcp47;

    const urls = [];
    const downloadables = track.ttDownloadables || track.downloadables || {};

    for (const [format, dlInfo] of Object.entries(downloadables)) {
      if (!dlInfo || typeof dlInfo !== 'object') continue;

      const urlSources = dlInfo.urls || dlInfo.downloadUrls || {};

      if (typeof urlSources === 'object' && urlSources !== null) {
        for (const entry of Object.values(urlSources)) {
          const url =
            typeof entry === 'string'
              ? entry
              : entry?.url || entry?.cdn_url || null;
          if (url) {
            urls.push({ url, format });
          }
        }
      }

      if (dlInfo.url) {
        urls.push({ url: dlInfo.url, format });
      }
    }

    if (urls.length === 0) {
      console.log('[NovaVox] Track has no URLs:', bcp47, Object.keys(downloadables));
      return null;
    }

    return {
      language: bcp47,
      displayName,
      trackType: track.trackType || 'SUBTITLES',
      urls,
      movieId: track.movieId || track.new_track_id || null,
      isForced: track.isForcedNarrative || false,
    };
  }

  // ═══════════════════════════════════════════════
  // YouTube
  // ═══════════════════════════════════════════════

  function processYouTubeParse(result) {
    if (!result || typeof result !== 'object') return;

    // Only process objects that look like a real player response
    // Must have videoDetails or playabilityStatus to be genuine
    if (!result.videoDetails && !result.playabilityStatus) return;

    // Skip ad responses
    if (result.adPlacements || result.playerAds) return;

    const title = result.videoDetails?.title || document.title || '';

    // Extract subtitle tracks — use known YouTube path directly
    const captionTracks =
      result.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (captionTracks.length > 0) {
      const tracks = captionTracks.map(normalizeYouTubeTrack).filter(Boolean);
      if (tracks.length > 0) {
        console.log('[NovaVox] YouTube subtitles:', tracks.map(t => t.displayName).join(', '));
        window.postMessage({ type: 'novavox_subs', tracks }, '*');
        window.__novavoxTracks = tracks;
      }
    }

    // Extract media for downloads — use known YouTube path directly
    const sd = result.streamingData;
    if (sd) {
      const media = extractYouTubeMedia(sd);
      if (media.length > 0) {
        console.log('[NovaVox] YouTube media:', media.length, 'streams detected');
        window.postMessage({ type: 'novavox_media', media, title }, '*');
        window.__novavoxMedia = media;
        window.__novavoxTitle = title;
      }
    }
  }

  function normalizeYouTubeTrack(track) {
    // Validate: must have a URL and a language code
    if (!track.baseUrl || !track.baseUrl.startsWith('http')) return null;
    if (!track.languageCode) return null;

    const vttUrl =
      track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=vtt';
    return {
      language: track.languageCode,
      displayName:
        track.name?.simpleText ||
        track.name?.runs?.[0]?.text ||
        track.languageCode,
      trackType: track.kind === 'asr' ? 'AUTO' : 'SUBTITLES',
      urls: [{ url: vttUrl, format: 'webvtt' }],
      movieId: null,
      isForced: false,
    };
  }

  function extractYouTubeMedia(sd) {
    const media = [];

    // Muxed formats (video + audio together — directly playable)
    for (const f of sd.formats || []) {
      if (!isValidFormat(f)) continue;
      const label = f.qualityLabel || (f.height ? `${f.height}p` : null);
      if (!label) continue;
      media.push({
        url: f.url,
        type: 'video+audio',
        mimeType: f.mimeType,
        quality: label,
        size: f.contentLength ? parseInt(f.contentLength) : null,
        width: f.width || null,
        height: f.height || null,
      });
    }

    // Adaptive formats (separate streams)
    for (const f of sd.adaptiveFormats || []) {
      if (!isValidFormat(f)) continue;
      const mime = f.mimeType;
      const isAudio = mime.startsWith('audio/');
      const label = isAudio
        ? (f.audioQuality || `${Math.round((f.bitrate || 0) / 1000)}kbps`)
        : (f.qualityLabel || (f.height ? `${f.height}p` : null));
      if (!label) continue;
      media.push({
        url: f.url,
        type: isAudio ? 'audio' : 'video',
        mimeType: mime,
        quality: label,
        size: f.contentLength ? parseInt(f.contentLength) : null,
        width: f.width || null,
        height: f.height || null,
      });
    }

    return media;
  }

  function isValidFormat(f) {
    // Must have a real URL and a recognized mime type
    if (!f.url || !f.url.startsWith('http')) return false;
    if (!f.mimeType) return false;
    if (!f.mimeType.startsWith('video/') && !f.mimeType.startsWith('audio/')) return false;
    return true;
  }
})();
