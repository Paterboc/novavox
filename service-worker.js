// Service worker — context menu translate + message relay

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translate-selection',
    title: 'Translate "%s"',
    contexts: ['selection'],
  });
});

// Track which tabs already have the script injected
const injectedTabs = new Set();

// Clean up when tabs close or navigate
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    injectedTabs.delete(tabId);
  }
});

// Handle context menu click — inject JS+CSS on demand, then send selection
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'translate-selection' || !info.selectionText || !tab?.id) return;

  // Inject CSS + JS only on first use per tab
  if (!injectedTabs.has(tab.id)) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/hover-translate.css'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/hover-translate.js'],
      });
      injectedTabs.add(tab.id);
    } catch (e) {
      // Restricted page (chrome://, etc.) — ignore
      return;
    }
  }

  chrome.tabs.sendMessage(tab.id, {
    type: 'TRANSLATE_SELECTION',
    text: info.selectionText.trim(),
  });
});

// Relay messages between popup and content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ tabId: tabs[0]?.id });
    });
    return true;
  }
});
