# NovaVox

Watch in any language. Dual subtitles, media downloads, and instant translate for Netflix, YouTube, and any website — zero setup, runs entirely in your browser.

## What It Does

- **Dual Subtitles** — display two subtitle languages at once on Netflix and YouTube
- **Download Media** — save video, audio, and subtitle files from YouTube
- **Instant Translate** — right-click any text on any website to translate it instantly

## Installation

1. Clone or download this repository
   ```
   git clone https://github.com/Paterboc/novavox.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `novavox` folder
5. The NovaVox icon appears in your toolbar

No API keys, no accounts, no external software.

## Features

### Dual Subtitles

Display a secondary subtitle language below the native subtitles while watching Netflix or YouTube.

- Automatic subtitle detection — NovaVox reads every subtitle language the platform offers
- Pick a language from the dropdown and it appears instantly
- Auto-sync with calibration — timing adjusts on seek, skip, and resume
- Three font sizes (S / M / L)
- Works in fullscreen

**How to use:**
1. Play a video on Netflix or YouTube
2. Click the NovaVox icon → **Subtitles** tab
3. Toggle **Dual subtitles** on
4. Pick your secondary language from the dropdown

### Media Downloads

Save video, audio, and subtitles from YouTube directly to your computer.

- **Video** — ready-to-play files with audio included (up to 720p)
- **Audio** — extract just the audio track (music, podcasts, lectures)
- **Subtitles** — download any available subtitle track as a .vtt file

All media is detected from the page itself — nothing is proxied, re-encoded, or sent to external servers.

**How to use:**
1. Open a YouTube video
2. Click the NovaVox icon → **Downloads** tab
3. Pick a quality and click **Download**

> Netflix video streams are DRM-encrypted and cannot be downloaded. Netflix subtitles (plain text) can be downloaded.

### Instant Translate

Translate selected text on any website with a right-click. Works everywhere — not just streaming sites.

- Select text on Reddit, Wikipedia, Twitter/X, news articles, blogs, Amazon, forums — literally any webpage
- Right-click → **Translate** — a tooltip shows the translation and detected source language
- Auto-detects the source language
- 32 target languages
- Works on Netflix/YouTube subtitles and the dual subtitle overlay too

**How to use:**
1. Select text on any page
2. Right-click → **Translate "[text]"**
3. Change target language anytime in the NovaVox popup

## Supported Sites

| | Dual Subs | Video Download | Audio Download | Subtitle Download | Translate |
|---|---|---|---|---|---|
| **Netflix** | Yes | No (DRM) | No (DRM) | Yes | Yes |
| **YouTube** | Yes | Yes | Yes | Yes | Yes |
| **Any website** | — | — | — | — | Yes |

The translate feature works on every website: social media, news, forums, e-commerce, documentation — anything with selectable text.

## Supported Subtitle Formats

| Format | Used By |
|--------|---------|
| TTML / DFXP | Netflix |
| WebVTT | YouTube |
| SRT | Internal parser (used for compatibility) |

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves your language and font preferences |
| `activeTab` | Reads the current tab to overlay subtitles |
| `contextMenus` | Adds "Translate" to right-click menu |
| `scripting` | Injects the translate tooltip on demand |
| `downloads` | Saves video/audio/subtitle files to your computer |
| Host access | Netflix + YouTube domains for subtitle and media data; Google Translate API |

## Requirements

- Google Chrome, Edge, Brave, Arc, or any Chromium-based browser
- Netflix subscription (for Netflix features)

## License

MIT
