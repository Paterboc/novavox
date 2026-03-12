// ISOLATED world — orchestrates secondary subtitle fetching, parsing, and overlay rendering
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
  let timeOffset = 0; // auto-calibrated offset in seconds

  const FONT_SIZES = {
    small: 'clamp(12px, 1.4vw, 22px)',
    medium: 'clamp(16px, 2vw, 30px)',
    large: 'clamp(20px, 2.6vw, 40px)',
  };

  // ── Bootstrap ──

  init();

  function init() {
    listenForTracks();
    listenForMessages();
    loadSavedPreference();

    // Request buffered tracks in case MAIN world captured them before we loaded
    window.postMessage({ type: 'netflix_dual_subs_replay' }, '*');
  }

  // ── Track Capture (from MAIN world via postMessage) ──

  function listenForTracks() {
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (!e.data || e.data.type !== 'netflix_dual_subs') return;

      const tracks = e.data.tracks;
      if (!Array.isArray(tracks) || tracks.length === 0) return;

      handleTracks(tracks);
    });
  }

  function handleTracks(tracks) {
    // Detect title change via movieId
    const movieId = tracks[0]?.movieId;
    if (movieId && movieId !== currentMovieId) {
      currentMovieId = movieId;
      clearOverlay();
      store = null;
      availableTracks = [];
      timeOffset = 0;
      lastNativeText = '';
      consecutiveMisses = 0;
      calibrationLocked = false;
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
      console.warn('[DualSubs] No track found for', lang);
      return;
    }

    // Prefer TTML/DFXP over WebVTT (Netflix usually serves TTML)
    const preferred = pickBestUrl(track.urls);

    try {
      const resp = await fetch(preferred.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();

      let cues;
      if (
        preferred.format.includes('dfxp') ||
        preferred.format.includes('ttml') ||
        preferred.format.includes('xml') ||
        text.trimStart().startsWith('<?xml') ||
        text.trimStart().startsWith('<tt')
      ) {
        cues = TTMLParser.parse(text);
      } else {
        cues = WebVTTParser.parse(text);
      }

      store = SubtitleStore.create(cues);
      ensureOverlay();
      startSync();
    } catch (err) {
      console.error('[DualSubs] Failed to load subtitle:', err);
    }
  }

  function pickBestUrl(urls) {
    // Prefer TTML/DFXP, fall back to whatever is available
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
    overlayEl.id = 'netflix-dual-subs-overlay';
    overlayEl.setAttribute(
      'style',
      [
        'position: fixed',
        'bottom: 10vh',
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
      ].join('; ')
    );

    injectOverlay();

    // Re-inject if DOM restructures (Netflix SPA navigation)
    const bodyObserver = new MutationObserver(() => {
      if (!document.contains(overlayEl)) {
        injectOverlay();
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function injectOverlay() {
    document.body.appendChild(overlayEl);
    injectSubtitleSelectStyles();
  }

  // Make native Netflix subtitles selectable for hover-translate
  let subtitleStylesInjected = false;
  function injectSubtitleSelectStyles() {
    if (subtitleStylesInjected) return;
    subtitleStylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .player-timedtext, .player-timedtext span {
        user-select: text !important;
        -webkit-user-select: text !important;
        pointer-events: auto !important;
      }
    `;
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
    stopPeriodicCalibration();
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

  function bindVideoEvents() {
    const video = document.querySelector('video');
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
    // Force immediate re-sync after seek
    lastSyncWall = 0;
    if (store) {
      store._lastTime = 0;
      store._lastIdx = 0;
    }

    // Reset calibration — old samples are from a different position
    lastNativeText = '';
    consecutiveMisses = 0;
    calibrationLocked = false;

    renderNow();
  }

  function onPlay() {
    // Force immediate re-sync when resuming from pause
    lastSyncWall = 0;
    renderNow();
  }

  function onTimeUpdate() {
    // Native video event — fires reliably even when rAF is throttled
    // (background tabs, long pause, etc.)
    const wallNow = performance.now();
    if (wallNow - lastSyncWall < 200) return;
    renderNow();
  }

  function renderNow() {
    if (!store || !overlayEl) return;
    const video = boundVideo || document.querySelector('video');
    if (!video) return;

    const now = video.currentTime + timeOffset;
    lastSyncWall = performance.now();

    const cues = SubtitleStore.getCuesAt(store, now);
    const text = cues.map((c) => c.text).join('\n');

    if (text !== lastRenderedText) {
      lastRenderedText = text;
      if (text) {
        // Wrap in a span with pointer-events so hover-translate can detect words
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

    const video = document.querySelector('video');
    if (!video) return;

    // Re-bind if video element changed (Netflix SPA navigation)
    if (video !== boundVideo) bindVideoEvents();

    // Throttle to ~4 Hz using wall-clock time
    // This is a backup — timeupdate event is the primary sync driver
    const wallNow = performance.now();
    if (wallNow - lastSyncWall < 200) return;

    renderNow();
  }

  // ── Auto-calibration ──
  // Netflix serves both tracks on the same timeline, so offset defaults to 0.
  // Only recalibrate for large, consistent desyncs (e.g., file offset by
  // several seconds). Small gaps between tracks are normal — different
  // languages segment dialogue into cues differently.
  let lastNativeText = '';
  let periodicCalibrationTimer = null;
  let consecutiveMisses = 0;
  let calibrationLocked = false;

  const timedTextObserver = new MutationObserver(() => {
    if (!store || !boundVideo) return;

    const el = document.querySelector('.player-timedtext');
    if (!el) return;

    const nativeText = el.innerText.trim();
    if (!nativeText || nativeText === lastNativeText) return;
    lastNativeText = nativeText;

    const adjustedTime = boundVideo.currentTime + timeOffset;
    const activeCues = SubtitleStore.getCuesAt(store, adjustedTime);

    if (activeCues.length > 0) {
      // Current offset is working fine.
      consecutiveMisses = 0;
      return;
    }

    // Native sub showing but no secondary cue. Could be a normal
    // segmentation gap or a real desync. Count it.
    consecutiveMisses++;
  });

  // Periodic check — only applies an offset if there's strong evidence
  // of a large, consistent desync (many consecutive misses).
  function calibratePeriodic() {
    if (!store || !boundVideo || calibrationLocked) return;
    if (boundVideo.paused) return;

    const adjustedTime = boundVideo.currentTime + timeOffset;
    const activeCues = SubtitleStore.getCuesAt(store, adjustedTime);

    if (activeCues.length > 0) {
      consecutiveMisses = 0;
      return;
    }

    consecutiveMisses++;

    // Only recalibrate after 6+ consecutive misses (~60s of no matching cues).
    // This filters out normal cue segmentation gaps.
    if (consecutiveMisses < 6) return;

    // Search for the nearest cue to the raw video time.
    const videoTime = boundVideo.currentTime;
    const cues = store.cues;

    // Binary search for rightmost cue with start <= videoTime
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (cues[mid].start <= videoTime) lo = mid + 1;
      else hi = mid - 1;
    }

    // Find the nearest cue start among neighbors
    let bestOffset = null;
    let bestDist = Infinity;
    for (let i = Math.max(0, hi - 1); i <= Math.min(cues.length - 1, hi + 2); i++) {
      const dist = Math.abs(cues[i].start - videoTime);
      if (dist < bestDist) {
        bestDist = dist;
        bestOffset = cues[i].start - videoTime;
      }
    }

    // Only apply if the offset is large (>1s) — small differences are
    // normal segmentation gaps, not real desync.
    if (bestOffset !== null && Math.abs(bestOffset) > 1) {
      console.log('[DualSubs] Large desync detected, calibrating offset:',
        timeOffset.toFixed(3) + 's →', bestOffset.toFixed(3) + 's');
      timeOffset = bestOffset;
      consecutiveMisses = 0;
      calibrationLocked = true; // Don't keep adjusting
      renderNow();
    }
  }

  function startPeriodicCalibration() {
    if (periodicCalibrationTimer) return;
    periodicCalibrationTimer = setInterval(calibratePeriodic, 10000);
  }

  function stopPeriodicCalibration() {
    if (periodicCalibrationTimer) {
      clearInterval(periodicCalibrationTimer);
      periodicCalibrationTimer = null;
    }
  }

  function observeNativeSubs() {
    const el = document.querySelector('.player-timedtext');
    if (el) {
      timedTextObserver.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    startPeriodicCalibration();
  }

  // Retry observation until Netflix player is ready
  const readyObserver = new MutationObserver(() => {
    if (document.querySelector('.player-timedtext')) {
      observeNativeSubs();
      readyObserver.disconnect();
    }
  });
  readyObserver.observe(document.body, { childList: true, subtree: true });
})();
