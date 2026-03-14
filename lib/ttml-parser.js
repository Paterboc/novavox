// Parse Netflix TTML/DFXP subtitle XML into cues [{start, end, text}]
var TTMLParser = (function () {
  'use strict';

  function parse(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    if (doc.querySelector('parsererror')) {
      throw new Error('TTML parse error');
    }

    // Read timing parameters from the <tt> root element
    const tt = doc.querySelector('tt');
    const tickRate = readAttr(tt, 'tickRate', 10000000);
    const frameRate = readAttr(tt, 'frameRate', 24);
    const subFrameRate = readAttr(tt, 'subFrameRate', 1);
    const frameRateMultiplier = readFrameRateMultiplier(tt);
    const effectiveFrameRate = frameRate * frameRateMultiplier;

    console.log('[NovaVox] TTML tickRate:', tickRate,
      'frameRate:', frameRate, 'multiplier:', frameRateMultiplier,
      'effective:', effectiveFrameRate);

    const cues = [];
    const paragraphs = doc.querySelectorAll('p[begin]');

    for (const p of paragraphs) {
      const start = parseTimestamp(p.getAttribute('begin'), tickRate, effectiveFrameRate);
      let end;

      if (p.hasAttribute('end')) {
        end = parseTimestamp(p.getAttribute('end'), tickRate, effectiveFrameRate);
      } else if (p.hasAttribute('dur')) {
        end = start + parseTimestamp(p.getAttribute('dur'), tickRate, effectiveFrameRate);
      } else {
        continue;
      }

      const text = extractText(p);
      if (text) {
        cues.push({ start, end, text });
      }
    }

    cues.sort((a, b) => a.start - b.start);

    if (cues.length > 0) {
      console.log('[NovaVox] Parsed', cues.length, 'cues, first:',
        cues[0].start.toFixed(3) + 's, last:',
        cues[cues.length - 1].end.toFixed(3) + 's');
    }

    return cues;
  }

  function readAttr(el, localName, defaultVal) {
    if (!el) return defaultVal;
    // Try ttp: namespace and plain attribute
    const val = el.getAttributeNS('http://www.w3.org/ns/ttml#parameter', localName)
      || el.getAttribute('ttp:' + localName)
      || el.getAttribute(localName);
    if (val) {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return defaultVal;
  }

  function readFrameRateMultiplier(el) {
    if (!el) return 1;
    const val = el.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'frameRateMultiplier')
      || el.getAttribute('ttp:frameRateMultiplier');
    if (val) {
      const parts = val.trim().split(/\s+/);
      if (parts.length === 2) {
        const num = parseInt(parts[0], 10);
        const den = parseInt(parts[1], 10);
        if (num > 0 && den > 0) return num / den;
      }
    }
    return 1;
  }

  function parseTimestamp(ts, tickRate, frameRate) {
    if (!ts) return 0;

    // Tick format: "1234t"
    const tickMatch = ts.match(/^(\d+)t$/);
    if (tickMatch) {
      return parseInt(tickMatch[1], 10) / tickRate;
    }

    // HH:MM:SS.mmm or HH:MM:SS:FF
    const parts = ts.split(':');
    if (parts.length >= 3) {
      const hours = parseInt(parts[0], 10) || 0;
      const minutes = parseInt(parts[1], 10) || 0;
      const secParts = parts[2].split('.');
      const seconds = parseInt(secParts[0], 10) || 0;
      const frac = secParts[1]
        ? parseInt(secParts[1], 10) / Math.pow(10, secParts[1].length)
        : 0;

      // 4th part = frames — use actual frame rate from header
      let frameSec = 0;
      if (parts.length === 4) {
        frameSec = (parseInt(parts[3], 10) || 0) / frameRate;
      }

      return hours * 3600 + minutes * 60 + seconds + frac + frameSec;
    }

    return parseFloat(ts) || 0;
  }

  function extractText(node) {
    let text = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      } else if (child.nodeName === 'br' || child.localName === 'br') {
        text += '\n';
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        text += extractText(child);
      }
    }
    return text.trim();
  }

  return { parse };
})();
