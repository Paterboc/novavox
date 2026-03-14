// ISOLATED world — subtitle overlay + media relay (Netflix + YouTube)
(function () {
  'use strict';

  // State
  let availableTracks = [];
  let currentMovieId = null;
  let secondaryLang = null;
  let store = null;
  let overlayEl = null;
  let rafId = null;
  let lastRenderedText = '';
  let lastSyncWall = 0;
  let currentFontSize = 'small';
  let boundVideo = null;
  let timeOffset = 0;

  const site = location.hostname.includes('youtube.com') ? 'youtube'
    : location.hostname.includes('netflix.com') ? 'netflix'
    : 'other';

  const FONT_SIZES = {
    small: 'clamp(12px, 1.4vw, 22px)',
    medium: 'clamp(16px, 2vw, 30px)',
    large: 'clamp(20px, 2.6vw, 40px)',
  };

  // ── Bootstrap ──

  init();

  function init() {
    listenForTracks();
    listenForMedia();
    listenForMessages();
    loadSavedPreference();

    // Request buffered data in case MAIN world captured before we loaded
    window.postMessage({ type: 'novavox_subs_replay' }, '*');
    window.postMessage({ type: 'novavox_media_replay' }, '*');
  }

  // ── Track Capture (from MAIN world via postMessage) ──

  function listenForTracks() {
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (!e.data || e.data.type !== 'novavox_subs') return;

      const tracks = e.data.tracks;
      if (!Array.isArray(tracks) || tracks.length === 0) return;

      handleTracks(tracks);
    });
  }

  function handleTracks(tracks) {
    // Detect title change via movieId (Netflix) or track list change (YouTube)
    const movieId = tracks[0]?.movieId;
    if (site === 'netflix' && movieId && movieId !== currentMovieId) {
      currentMovieId = movieId;
      clearOverlay();
      store = null;
      availableTracks = [];
      timeOffset = 0;
      lastNativeText = '';
      calibrationSamples = [];
      lastCalibrationCheck = 0;
      calibrationCooldown = 0;
    }

    // Merge with existing tracks instead of replacing
    availableTracks = deduplicateTracks([...availableTracks, ...tracks]);

    // Persist for popup (strip URLs to stay within storage limits)
    chrome.storage.local.set({
      availableTracks: availableTracks.map((t) => ({
        language: t.language,
        displayName: t.displayName,
        trackType: t.trackType,
        isForced: t.isForced,
      })),
    });

    // Auto-load if we have a saved preference
    if (secondaryLang) {
      loadSecondaryTrack(secondaryLang);
    }
  }

  function deduplicateTracks(tracks) {
    const seen = new Map();
    for (const t of tracks) {
      const key = `${t.language}:${t.trackType}:${t.isForced}`;
      if (!seen.has(key)) {
        seen.set(key, t);
      }
    }
    return Array.from(seen.values());
  }

  // ── Media Relay (from MAIN world → service worker) ──

  function listenForMedia() {
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (e.data?.type !== 'novavox_media') return;

      chrome.runtime.sendMessage({
        type: 'STORE_MEDIA',
        media: e.data.media || [],
        title: e.data.title || '',
      });
    });
  }

  // ── Message Handling (from popup / service worker) ──

  function listenForMessages() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'LOAD_SECONDARY') {
        secondaryLang = msg.language;
        if (secondaryLang) {
          loadSecondaryTrack(secondaryLang);
        } else {
          disableOverlay();
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'SET_FONT_SIZE') {
        currentFontSize = msg.size || 'small';
        if (overlayEl) {
          overlayEl.style.fontSize = FONT_SIZES[currentFontSize] || FONT_SIZES.small;
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'GET_STATUS') {
        sendResponse({
          hasTrack: store !== null,
          language: secondaryLang,
          trackCount: availableTracks.length,
        });
      } else if (msg.type === 'DOWNLOAD_TRACK') {
        const track = availableTracks.find(
          (t) => t.language === msg.language && !t.isForced
        );
        if (track && track.urls.length > 0) {
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_SUBTITLE',
            url: track.urls[0].url,
            filename: msg.filename || `subtitles_${track.language}.vtt`,
          });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Track not found' });
        }
      }
      return true;
    });
  }

  function loadSavedPreference() {
    chrome.storage.local.get(['secondaryLang', 'fontSize'], (result) => {
      if (result.secondaryLang) {
        secondaryLang = result.secondaryLang;
      }
      if (result.fontSize) {
        currentFontSize = result.fontSize;
      }
    });
  }

  // ── Subtitle Loading ──

  async function loadSecondaryTrack(lang) {
    const track = availableTracks.find(
      (t) => t.language === lang && !t.isForced
    );
    if (!track || !track.urls.length) {
      console.warn('[NovaVox] No track found for', lang);
      return;
    }

    const preferred = pickBestUrl(track.urls);

    try {
      const resp = await fetch(preferred.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();

      const cues = parseSubtitleText(text, preferred.format);
      store = SubtitleStore.create(cues);
      ensureOverlay();
      startSync();
    } catch (err) {
      console.error('[NovaVox] Failed to load subtitle:', err);
    }
  }

  function parseSubtitleText(text, format) {
    const trimmed = text.trimStart();
    if (
      format.includes('dfxp') ||
      format.includes('ttml') ||
      format.includes('xml') ||
      trimmed.startsWith('<?xml') ||
      trimmed.startsWith('<tt')
    ) {
      return TTMLParser.parse(text);
    }
    if (format === 'srt' || (!format.includes('vtt') && !trimmed.startsWith('WEBVTT') && trimmed.match(/^\d+\r?\n\d{2}:\d{2}:\d{2}/))) {
      return SRTParser.parse(text);
    }
    return WebVTTParser.parse(text);
  }

  function pickBestUrl(urls) {
    const ttml = urls.find(
      (u) =>
        u.format.includes('dfxp') ||
        u.format.includes('ttml') ||
        u.format.includes('xml')
    );
    return ttml || urls[0];
  }

  // ── Overlay DOM ──

  function ensureOverlay() {
    if (overlayEl && document.contains(overlayEl)) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'novavox-overlay';

    const styles = [
      'left: 0',
      'right: 0',
      'text-align: center',
      'pointer-events: none',
      'z-index: 2147483647',
      'padding: 0 5vw 1vh',
      'font-family: Netflix Sans, Helvetica Neue, Segoe UI, sans-serif',
      'font-size: ' + (FONT_SIZES[currentFontSize] || FONT_SIZES.small),
      'color: rgba(255, 255, 255, 1)',
      'text-shadow: 0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.6)',
      'white-space: pre-wrap',
      'line-height: 1.3',
      'transition: none !important',
      'animation: none !important',
    ];

    if (site === 'youtube') {
      styles.push('position: absolute', 'bottom: 12%');
    } else {
      styles.push('position: fixed', 'bottom: 10vh');
    }

    overlayEl.setAttribute('style', styles.join('; '));

    injectOverlay();

    // Re-inject if DOM restructures (SPA navigation)
    const bodyObserver = new MutationObserver(() => {
      if (!document.contains(overlayEl)) {
        injectOverlay();
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function injectOverlay() {
    if (site === 'youtube') {
      const player = document.querySelector('#movie_player');
      if (player) {
        if (getComputedStyle(player).position === 'static') {
          player.style.position = 'relative';
        }
        player.appendChild(overlayEl);
      } else {
        document.body.appendChild(overlayEl);
      }
    } else {
      document.body.appendChild(overlayEl);
    }
    injectSubtitleSelectStyles();
  }

  // Make native subtitles selectable for hover-translate
  let subtitleStylesInjected = false;
  function injectSubtitleSelectStyles() {
    if (subtitleStylesInjected) return;
    subtitleStylesInjected = true;
    const style = document.createElement('style');
    if (site === 'youtube') {
      style.textContent = `
        .ytp-caption-window-container, .ytp-caption-window-container span {
          user-select: text !important;
          -webkit-user-select: text !important;
          pointer-events: auto !important;
        }
      `;
    } else {
      style.textContent = `
        .player-timedtext, .player-timedtext span {
          user-select: text !important;
          -webkit-user-select: text !important;
          pointer-events: auto !important;
        }
      `;
    }
    document.head.appendChild(style);
  }

  function clearOverlay() {
    if (overlayEl) {
      overlayEl.textContent = '';
      lastRenderedText = '';
    }
  }

  function disableOverlay() {
    stopSync();
    clearOverlay();
    store = null;
    secondaryLang = null;
  }

  // ── Sync Loop ──

  function startSync() {
    if (rafId) return;
    bindVideoEvents();
    syncTick();
  }

  function stopSync() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (boundVideo) {
      boundVideo.removeEventListener('seeked', onSeeked);
      boundVideo.removeEventListener('play', onPlay);
      boundVideo.removeEventListener('timeupdate', onTimeUpdate);
      boundVideo = null;
    }
  }

  function findVideo() {
    if (site === 'youtube') {
      return document.querySelector('#movie_player video') || document.querySelector('video');
    }
    return document.querySelector('video');
  }

  function bindVideoEvents() {
    const video = findVideo();
    if (!video || video === boundVideo) return;

    if (boundVideo) {
      boundVideo.removeEventListener('seeked', onSeeked);
      boundVideo.removeEventListener('play', onPlay);
      boundVideo.removeEventListener('timeupdate', onTimeUpdate);
    }

    boundVideo = video;
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('play', onPlay);
    video.addEventListener('timeupdate', onTimeUpdate);
  }

  function onSeeked() {
    lastSyncWall = 0;
    if (store) {
      store._lastTime = 0;
      store._lastIdx = 0;
    }
    lastNativeText = '';
    calibrationSamples = [];
    lastCalibrationCheck = 0;
    calibrationCooldown = 0;
    renderNow();
  }

  function onPlay() {
    lastSyncWall = 0;
    renderNow();
  }

  function onTimeUpdate() {
    const wallNow = performance.now();
    if (wallNow - lastSyncWall < 200) return;
    renderNow();
  }

  function renderNow() {
    if (!store || !overlayEl) return;
    const video = boundVideo || findVideo();
    if (!video) return;

    const now = video.currentTime + timeOffset;
    lastSyncWall = performance.now();

    const cues = SubtitleStore.getCuesAt(store, now);
    const text = cues.map((c) => c.text).join('\n');

    if (text !== lastRenderedText) {
      lastRenderedText = text;
      if (text) {
        overlayEl.innerHTML = '';
        const span = document.createElement('span');
        span.textContent = text;
        span.style.pointerEvents = 'auto';
        span.style.cursor = 'text';
        span.style.userSelect = 'text';
        span.style.webkitUserSelect = 'text';
        overlayEl.appendChild(span);
      } else {
        overlayEl.textContent = '';
      }
    }
  }

  function syncTick() {
    rafId = requestAnimationFrame(syncTick);

    if (!store || !overlayEl) return;

    const video = findVideo();
    if (!video) return;

    if (video !== boundVideo) bindVideoEvents();

    const wallNow = performance.now();
    if (wallNow - lastSyncWall < 200) return;

    renderNow();
  }

  // ── Auto-calibration ──
  // Only calibrate when native subs are visible (positive evidence of dialogue).
  // Collect offset samples and apply the median after enough consistent readings.
  // Never lock — allow continuous recalibration with cooldown.

  let lastNativeText = '';
  let calibrationSamples = [];
  let lastCalibrationCheck = 0;
  let calibrationCooldown = 0;

  const nativeSubSelector = site === 'youtube'
    ? '.ytp-caption-window-container'
    : '.player-timedtext';

  const timedTextObserver = new MutationObserver(() => {
    if (!store || !boundVideo || boundVideo.paused) return;

    const el = document.querySelector(nativeSubSelector);
    if (!el) return;

    const nativeText = el.innerText.trim();
    if (!nativeText || nativeText === lastNativeText) return;
    lastNativeText = nativeText;

    // Throttle: check at most every 2s
    const now = performance.now();
    if (now - lastCalibrationCheck < 2000) return;
    lastCalibrationCheck = now;

    // Cooldown after a calibration was applied
    if (now < calibrationCooldown) return;

    const adjustedTime = boundVideo.currentTime + timeOffset;

    // Check ±1s window to account for segmentation differences between languages
    const hasMatch =
      SubtitleStore.getCuesAt(store, adjustedTime).length > 0 ||
      SubtitleStore.getCuesAt(store, adjustedTime - 1).length > 0 ||
      SubtitleStore.getCuesAt(store, adjustedTime + 1).length > 0;

    if (hasMatch) {
      // In sync — clear any accumulated samples
      if (calibrationSamples.length > 0) calibrationSamples = [];
      return;
    }

    // Native subs visible but no secondary match — record potential offset
    const videoTime = boundVideo.currentTime;
    const nearest = findNearestCueOffset(store.cues, videoTime);
    if (!nearest || nearest.dist > 60) return;

    calibrationSamples.push(nearest.offset);
    if (calibrationSamples.length > 10) calibrationSamples.shift();

    // Need at least 3 consistent samples before applying
    if (calibrationSamples.length < 3) return;

    // Check consistency: all samples must be within 2s of each other
    const sorted = calibrationSamples.slice().sort((a, b) => a - b);
    const range = sorted[sorted.length - 1] - sorted[0];
    if (range > 2) {
      // Inconsistent — discard oldest half and wait for more data
      calibrationSamples = calibrationSamples.slice(-Math.ceil(calibrationSamples.length / 2));
      return;
    }

    const medianOffset = sorted[Math.floor(sorted.length / 2)];

    // Only apply if meaningfully different from current offset
    if (Math.abs(medianOffset - timeOffset) < 0.3) {
      calibrationSamples = [];
      return;
    }

    console.log('[NovaVox] Auto-calibrating: offset',
      timeOffset.toFixed(2) + 's →', medianOffset.toFixed(2) + 's',
      '(' + calibrationSamples.length + ' samples, range: ' + range.toFixed(2) + 's)');
    timeOffset = medianOffset;
    calibrationSamples = [];
    calibrationCooldown = performance.now() + 15000;
    renderNow();
  });

  function findNearestCueOffset(cues, time) {
    if (!cues.length) return null;

    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (cues[mid].start <= time) lo = mid + 1;
      else hi = mid - 1;
    }

    let best = null;
    let bestDist = Infinity;
    for (let i = Math.max(0, hi - 3); i <= Math.min(cues.length - 1, lo + 3); i++) {
      const d = Math.abs(cues[i].start - time);
      if (d < bestDist) {
        bestDist = d;
        best = { offset: cues[i].start - time, dist: d };
      }
    }

    return best;
  }

  function observeNativeSubs() {
    const el = document.querySelector(nativeSubSelector);
    if (el) {
      timedTextObserver.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  const readyObserver = new MutationObserver(() => {
    if (document.querySelector(nativeSubSelector)) {
      observeNativeSubs();
      readyObserver.disconnect();
    }
  });
  readyObserver.observe(document.body, { childList: true, subtree: true });

  // YouTube: re-detect tracks on SPA navigation (video change)
  if (site === 'youtube') {
    let lastUrl = location.href;
    const navObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Reset for new video
        clearOverlay();
        store = null;
        availableTracks = [];
        timeOffset = 0;
        lastNativeText = '';
        calibrationSamples = [];
        lastCalibrationCheck = 0;
        calibrationCooldown = 0;
        chrome.storage.local.set({ availableTracks: [] });
        // Request new tracks after a brief delay for page to load
        setTimeout(() => {
          window.postMessage({ type: 'novavox_subs_replay' }, '*');
          window.postMessage({ type: 'novavox_media_replay' }, '*');
        }, 2000);
      }
    });
    navObserver.observe(document.body, { childList: true, subtree: true });
  }
})();
