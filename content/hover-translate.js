// Right-click context menu translate — shows translation tooltip for selected text
(function () {
  'use strict';

  let enabled = true;
  let targetLang = 'en';
  let tooltip = null;
  let fetchController = null;

  const LANG_NAMES = {
    af: 'Afrikaans', ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali', ca: 'Catalan',
    cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek', en: 'English',
    es: 'Spanish', et: 'Estonian', fa: 'Persian', fi: 'Finnish', fr: 'French',
    gu: 'Gujarati', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
    id: 'Indonesian', it: 'Italian', ja: 'Japanese', jw: 'Javanese', kn: 'Kannada',
    ko: 'Korean', lt: 'Lithuanian', lv: 'Latvian', ml: 'Malayalam', mr: 'Marathi',
    ms: 'Malay', my: 'Burmese', ne: 'Nepali', nl: 'Dutch', no: 'Norwegian',
    pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', si: 'Sinhala',
    sk: 'Slovak', sl: 'Slovenian', sq: 'Albanian', sr: 'Serbian', su: 'Sundanese',
    sv: 'Swedish', sw: 'Swahili', ta: 'Tamil', te: 'Telugu', th: 'Thai',
    tl: 'Filipino', tr: 'Turkish', uk: 'Ukrainian', ur: 'Urdu', vi: 'Vietnamese',
    'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)',
  };

  // ── Init ──

  chrome.storage.local.get(['hoverTranslate', 'translateTargetLang'], (r) => {
    enabled = r.hoverTranslate !== false; // default on
    targetLang = r.translateTargetLang || 'en';
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SET_HOVER_TRANSLATE') {
      enabled = msg.enabled;
      if (!enabled) hideTooltip();
    }

    if (msg.type === 'SET_TRANSLATE_TARGET') {
      targetLang = msg.lang || 'en';
    }

    if (msg.type === 'TRANSLATE_SELECTION') {
      if (!enabled) return;
      translateSelection(msg.text);
    }
  });

  // ── Tooltip DOM ──

  function ensureTooltip() {
    if (tooltip && document.contains(tooltip)) return tooltip;
    tooltip = document.createElement('div');
    tooltip.id = 'hover-translate-tooltip';
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function showTooltip(x, y, html) {
    const el = ensureTooltip();
    el.innerHTML = html;
    el.classList.add('visible');

    // Position: above the point, centered
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;

    let left = x - rect.width / 2;
    let top = y - rect.height - 14;

    // Keep on screen
    if (left < 8) left = 8;
    if (left + rect.width > vw - 8) left = vw - rect.width - 8;
    if (top < 8) top = y + 24; // flip below if no room above

    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function hideTooltip() {
    if (tooltip) {
      tooltip.classList.remove('visible');
    }
    if (fetchController) {
      fetchController.abort();
      fetchController = null;
    }
  }

  // ── Translate selected text ──

  function translateSelection(text) {
    if (!text) return;

    // Get position from current selection
    const sel = window.getSelection();
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;

    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top;
    }

    const display = text.length > 60 ? text.slice(0, 57) + '\u2026' : text;

    showTooltip(x, y,
      `<span class="ht-word">${escapeHtml(display)}</span>` +
      '<div class="ht-loading">translating\u2026</div>'
    );

    translate(text)
      .then(({ translation, detectedLang }) => {
        const langName = LANG_NAMES[detectedLang] || detectedLang;
        const isSame = translation.toLowerCase() === text.toLowerCase();

        showTooltip(x, y,
          `<span class="ht-word">${escapeHtml(display)}</span>` +
          `<span class="ht-lang">${escapeHtml(langName)}</span>` +
          (isSame ? '' :
            '<div class="ht-divider"></div>' +
            `<div class="ht-translation">${escapeHtml(translation)}</div>`
          )
        );
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        console.warn('[Translate]', err);
        hideTooltip();
      });
  }

  // ── Translation API ──

  async function translate(word) {
    if (fetchController) fetchController.abort();
    fetchController = new AbortController();

    const url = 'https://translate.googleapis.com/translate_a/single'
      + '?client=gtx&sl=auto&tl=' + encodeURIComponent(targetLang) + '&dt=t&dt=ld&dj=1'
      + '&q=' + encodeURIComponent(word);

    const resp = await fetch(url, { signal: fetchController.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const translation = (data.sentences || [])
      .map((s) => s.trans)
      .filter(Boolean)
      .join('');

    const detectedLang = data.src || data.ld_result?.srclangs?.[0] || 'auto';

    return { translation, detectedLang };
  }

  // ── Hide on click elsewhere ──

  document.addEventListener('mousedown', (e) => {
    if (tooltip && !tooltip.contains(e.target)) {
      hideTooltip();
    }
  }, { passive: true });

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
