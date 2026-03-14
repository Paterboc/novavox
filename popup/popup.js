// Popup — subtitles + downloads UI
(function () {
  'use strict';

  // ── DOM refs ──

  const tabs = document.querySelectorAll('.tab');
  const tabSubs = document.getElementById('tab-subs');
  const tabDownloads = document.getElementById('tab-downloads');

  const selectEl = document.getElementById('secondary-lang');
  const pickerEl = document.getElementById('track-picker');
  const noTracksEl = document.getElementById('no-tracks');
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');

  const dualSubsToggle = document.getElementById('dual-subs-toggle');
  const sizeBtns = document.querySelectorAll('.size-btn');
  const hoverToggle = document.getElementById('hover-translate');
  const translateTargetEl = document.getElementById('translate-target');

  const noMediaEl = document.getElementById('no-media');
  const mediaListEl = document.getElementById('media-list');

  // ── Tab switching ──

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.dataset.tab;
      tabSubs.classList.toggle('hidden', target !== 'subs');
      tabDownloads.classList.toggle('hidden', target !== 'downloads');

      if (target === 'downloads') {
        loadMediaList();
      }
    });
  });

  // ── Subtitle tab init ──

  chrome.storage.local.get(
    ['availableTracks', 'secondaryLang', 'dualSubsEnabled', 'fontSize', 'hoverTranslate', 'translateTargetLang'],
    (result) => {
      const savedSize = result.fontSize || 'small';
      sizeBtns.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.size === savedSize);
      });

      hoverToggle.checked = result.hoverTranslate !== false;
      translateTargetEl.value = result.translateTargetLang || 'en';

      const tracks = result.availableTracks || [];
      const savedLang = result.secondaryLang || '';
      const enabled = result.dualSubsEnabled === true;

      if (tracks.length === 0) {
        noTracksEl.classList.remove('hidden');
        pickerEl.classList.add('hidden');
        return;
      }

      noTracksEl.classList.add('hidden');
      pickerEl.classList.remove('hidden');

      const subtitleTracks = tracks.filter((t) => !t.isForced);
      for (const track of subtitleTracks) {
        const opt = document.createElement('option');
        opt.value = track.language;
        let label = track.displayName || track.language;
        if (track.trackType === 'AUTO') label += ' (auto)';
        opt.textContent = label;
        if (track.language === savedLang) {
          opt.selected = true;
        }
        selectEl.appendChild(opt);
      }

      dualSubsToggle.checked = enabled;
      updateControlsState(enabled);

      if (enabled && savedLang) {
        showStatus(savedLang);
      }
    }
  );

  // ── Helpers ──

  function sendToTab(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, msg);
      }
    });
  }

  function updateControlsState(enabled) {
    selectEl.disabled = !enabled;
    sizeBtns.forEach((btn) => { btn.disabled = !enabled; });
    if (!enabled) {
      statusBar.classList.add('hidden');
    }
  }

  function applySubtitles(enabled) {
    const lang = enabled ? (selectEl.value || null) : null;
    sendToTab({ type: 'LOAD_SECONDARY', language: lang });

    if (enabled && lang) {
      showStatus(lang);
    } else {
      statusBar.classList.add('hidden');
    }
  }

  function showStatus(lang) {
    const opt = selectEl.querySelector(`option[value="${lang}"]`);
    const name = opt?.textContent || lang;
    statusText.textContent = `Showing: ${name}`;
    statusBar.classList.remove('hidden');
  }

  // ── Subtitle controls ──

  dualSubsToggle.addEventListener('change', () => {
    const enabled = dualSubsToggle.checked;
    chrome.storage.local.set({ dualSubsEnabled: enabled });
    updateControlsState(enabled);
    applySubtitles(enabled);
  });

  selectEl.addEventListener('change', () => {
    const lang = selectEl.value;
    chrome.storage.local.set({ secondaryLang: lang || null });

    if (dualSubsToggle.checked && lang) {
      sendToTab({ type: 'LOAD_SECONDARY', language: lang });
      showStatus(lang);
    }
  });

  sizeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const size = btn.dataset.size;
      sizeBtns.forEach((b) => b.classList.toggle('active', b === btn));
      chrome.storage.local.set({ fontSize: size });
      sendToTab({ type: 'SET_FONT_SIZE', size });
    });
  });

  hoverToggle.addEventListener('change', () => {
    const enabled = hoverToggle.checked;
    chrome.storage.local.set({ hoverTranslate: enabled });
    sendToTab({ type: 'SET_HOVER_TRANSLATE', enabled });
  });

  translateTargetEl.addEventListener('change', () => {
    const targetLang = translateTargetEl.value;
    chrome.storage.local.set({ translateTargetLang: targetLang });
    sendToTab({ type: 'SET_TRANSLATE_TARGET', lang: targetLang });
  });

  // ── Downloads tab ──

  function loadMediaList() {
    chrome.runtime.sendMessage({ type: 'GET_MEDIA' }, (resp) => {
      const media = resp?.media || [];
      const title = resp?.title || 'video';

      // Also get subtitle tracks for download
      chrome.storage.local.get(['availableTracks'], (result) => {
        const subTracks = result.availableTracks || [];
        renderMediaList(media, subTracks, title);
      });
    });
  }

  function renderMediaList(media, subTracks, title) {
    mediaListEl.innerHTML = '';

    if (media.length === 0 && subTracks.length === 0) {
      noMediaEl.classList.remove('hidden');
      return;
    }

    noMediaEl.classList.add('hidden');

    // Only show muxed (video+audio) — these actually play after download
    // Skip "video only" streams entirely (useless without ffmpeg merge)
    const muxed = media
      .filter((m) => m.type === 'video+audio')
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    // For audio, pick the best quality per codec family, label simply
    const audioAll = media
      .filter((m) => m.type === 'audio')
      .sort((a, b) => (b.size || 0) - (a.size || 0));
    const audioPicks = pickBestAudio(audioAll);

    // ── Video ──
    if (muxed.length > 0) {
      addSection('Video');
      for (const m of muxed) {
        const ext = guessExt(m.mimeType);
        const filename = `${sanitize(title)}_${m.quality}.${ext}`;
        addMediaItem(
          m.quality,
          formatSize(m.size),
          () => downloadFile(m.url, filename)
        );
      }
    }

    // ── Audio ──
    if (audioPicks.length > 0) {
      addSection('Audio');
      for (const a of audioPicks) {
        const ext = guessExt(a.mimeType);
        const filename = `${sanitize(title)}_audio.${ext}`;
        addMediaItem(
          a.label,
          formatSize(a.size),
          () => downloadFile(a.url, filename)
        );
      }
    }

    // ── Subtitles ──
    if (subTracks.length > 0) {
      addSection('Subtitles');
      for (const track of subTracks) {
        const label = track.displayName || track.language;
        const tag = track.trackType === 'AUTO' ? ' (auto)' : '';
        const filename = `${sanitize(title)}_${track.language}.vtt`;
        addMediaItem(label + tag, null, () => {
          sendToTab({
            type: 'DOWNLOAD_TRACK',
            language: track.language,
            filename,
          });
        });
      }
    }
  }

  function pickBestAudio(audioStreams) {
    if (audioStreams.length === 0) return [];

    // Group by codec family (mp4a vs opus/vorbis)
    const mp4a = audioStreams.filter((a) => a.mimeType?.includes('mp4a') || a.mimeType?.includes('mp4'));
    const webm = audioStreams.filter((a) => a.mimeType?.includes('opus') || a.mimeType?.includes('webm') || a.mimeType?.includes('vorbis'));

    const picks = [];

    // Prefer mp4a (wider compatibility), label as "Best" / "Standard"
    const primary = mp4a.length > 0 ? mp4a : webm;
    const secondary = mp4a.length > 0 ? webm : [];

    if (primary.length > 0) {
      picks.push({ ...primary[0], label: primary.length === 1 ? 'Best quality' : 'Best quality' });
      // Add a smaller option if there's a meaningful size difference
      if (primary.length > 1) {
        const smallest = primary[primary.length - 1];
        const largest = primary[0];
        if (largest.size && smallest.size && smallest.size < largest.size * 0.6) {
          picks.push({ ...smallest, label: 'Smaller file' });
        }
      }
    }

    // Add best webm/opus as alternative if mp4a exists too
    if (secondary.length > 0 && picks.length > 0) {
      picks.push({ ...secondary[0], label: 'Best quality (webm)' });
    } else if (secondary.length > 0) {
      picks.push({ ...secondary[0], label: 'Best quality' });
    }

    return picks;
  }

  function addSection(label) {
    const div = document.createElement('div');
    div.className = 'section-label';
    div.textContent = label;
    mediaListEl.appendChild(div);
  }

  function addMediaItem(label, detail, onClick) {
    const item = document.createElement('div');
    item.className = 'media-item';

    const info = document.createElement('div');
    info.className = 'media-info';

    const q = document.createElement('div');
    q.className = 'media-quality';
    q.textContent = label;
    info.appendChild(q);

    if (detail) {
      const d = document.createElement('div');
      d.className = 'media-detail';
      d.textContent = detail;
      info.appendChild(d);
    }

    const btn = document.createElement('button');
    btn.className = 'download-btn';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => {
      btn.textContent = 'Starting...';
      btn.disabled = true;
      onClick();
      setTimeout(() => {
        btn.textContent = 'Download';
        btn.disabled = false;
      }, 3000);
    });

    item.appendChild(info);
    item.appendChild(btn);
    mediaListEl.appendChild(item);
  }

  function downloadFile(url, filename) {
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_FILE',
      url,
      filename,
    });
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function guessExt(mimeType) {
    if (!mimeType) return 'mp4';
    if (mimeType.includes('mp4')) return 'mp4';
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('mp4a') || mimeType.includes('m4a')) return 'm4a';
    if (mimeType.includes('opus')) return 'webm';
    if (mimeType.includes('vorbis')) return 'ogg';
    if (mimeType.includes('audio/')) return 'm4a';
    return 'mp4';
  }

  function sanitize(name) {
    return (name || 'video')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 100);
  }
})();
