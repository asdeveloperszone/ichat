/**
 * pwa.js — Install prompt handler
 * Must be loaded in <head> so beforeinstallprompt is captured before body parses.
 * Uses window._pwaPrompt so it's accessible from any inline script.
 */

window._pwaPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window._pwaPrompt = e;
  showInstallButton();
});

window.addEventListener('appinstalled', () => {
  window._pwaPrompt = null;
  hideInstallButton();
});

function showInstallButton() {
  const btn = document.getElementById('installAppBtn');
  if (btn) {
    btn.style.display = 'flex';
    btn.classList.add('install-btn-pop');
  }
}

function hideInstallButton() {
  const btn = document.getElementById('installAppBtn');
  if (btn) btn.style.display = 'none';
}

window.installApp = async function () {
  if (!window._pwaPrompt) return;
  window._pwaPrompt.prompt();
  const { outcome } = await window._pwaPrompt.userChoice;
  window._pwaPrompt = null;
  if (outcome === 'accepted') hideInstallButton();
};
