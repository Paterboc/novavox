// Popup — reads available tracks from storage, sends language selection to content script
(function () {
  'use strict';

  const selectEl = document.getElementById('secondary-lang');
  const pickerEl = document.getElementById('track-picker');
  const noTracksEl = document.getElementById('no-tracks');
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');

  const dualSubsToggle = document.getElementById('dual-subs-toggle');
  const sizeBtns = document.querySelectorAll('.size-btn');
  const hoverToggle = document.getElementById('hover-translate');
  const translateTargetEl = document.getElementById('translate-target');

  // Load available tracks and saved preferences
  chrome.storage.local.get(
    ['availableTracks', 'secondaryLang', 'dualSubsEnabled', 'fontSize', 'hoverTranslate', 'translateTargetLang'],
    (result) => {
      // Set active size button
      const savedSize = result.fontSize || 'small';
      sizeBtns.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.size === savedSize);
      });

      // Set hover translate toggle
      hoverToggle.checked = result.hoverTranslate !== false; // default on

      // Set translate target language
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

      // Populate dropdown — filter out forced narrative tracks
      const subtitleTracks = tracks.filter((t) => !t.isForced);
      for (const track of subtitleTracks) {
        const opt = document.createElement('option');
        opt.value = track.language;
        opt.textContent = track.displayName || track.language;
        if (track.language === savedLang) {
          opt.selected = true;
        }
        selectEl.appendChild(opt);
      }

      // Set toggle state
      dualSubsToggle.checked = enabled;
      updateControlsState(enabled);

      if (enabled && savedLang) {
        showStatus(savedLang);
      }
    }
  );

  // Helper: send message to active tab
  function sendToTab(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, msg);
      }
    });
  }

  // Helper: enable/disable controls based on toggle state
  function updateControlsState(enabled) {
    selectEl.disabled = !enabled;
    sizeBtns.forEach((btn) => { btn.disabled = !enabled; });
    if (!enabled) {
      statusBar.classList.add('hidden');
    }
  }

  // Activate or deactivate dual subs
  function applyDualSubs(enabled) {
    const lang = enabled ? (selectEl.value || null) : null;
    sendToTab({ type: 'LOAD_SECONDARY', language: lang });

    if (enabled && lang) {
      showStatus(lang);
    } else {
      statusBar.classList.add('hidden');
    }
  }

  // Handle dual subs toggle
  dualSubsToggle.addEventListener('change', () => {
    const enabled = dualSubsToggle.checked;
    chrome.storage.local.set({ dualSubsEnabled: enabled });
    updateControlsState(enabled);
    applyDualSubs(enabled);
  });

  // Handle language selection change
  selectEl.addEventListener('change', () => {
    const lang = selectEl.value;
    chrome.storage.local.set({ secondaryLang: lang || null });

    if (dualSubsToggle.checked && lang) {
      sendToTab({ type: 'LOAD_SECONDARY', language: lang });
      showStatus(lang);
    }
  });

  // Handle font size buttons
  sizeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const size = btn.dataset.size;
      sizeBtns.forEach((b) => b.classList.toggle('active', b === btn));
      chrome.storage.local.set({ fontSize: size });
      sendToTab({ type: 'SET_FONT_SIZE', size });
    });
  });

  // Handle hover translate toggle
  hoverToggle.addEventListener('change', () => {
    const enabled = hoverToggle.checked;
    chrome.storage.local.set({ hoverTranslate: enabled });
    sendToTab({ type: 'SET_HOVER_TRANSLATE', enabled });
  });

  // Handle translate target language change
  translateTargetEl.addEventListener('change', () => {
    const targetLang = translateTargetEl.value;
    chrome.storage.local.set({ translateTargetLang: targetLang });
    sendToTab({ type: 'SET_TRANSLATE_TARGET', lang: targetLang });
  });

  function showStatus(lang) {
    const opt = selectEl.querySelector(`option[value="${lang}"]`);
    const name = opt?.textContent || lang;
    statusText.textContent = `Showing: ${name}`;
    statusBar.classList.remove('hidden');
  }
})();
