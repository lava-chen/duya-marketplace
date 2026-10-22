// DUYA Browser Bridge - Popup Script

function setState(state, label, detail) {
  const statusCard = document.getElementById('statusCard');
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');
  const statusDetail = document.getElementById('statusDetail');

  statusCard.className = 'status-card ' + state;
  statusDot.className = 'status-dot ' + state;
  statusLabel.textContent = label;
  if (detail !== undefined) {
    statusDetail.textContent = detail;
  }
}

async function checkStatus() {
  setState('checking', 'Checking...', 'Checking Browser plugin connection');
  try {
    const data = await chrome.runtime.sendMessage({ type: 'ping' });
    if (data?.connected) {
      setState('connected', 'Connected', 'Browser plugin bridge active');
    } else {
      setState('disconnected', 'Not Connected', 'Start the Browser plugin MCP server');
    }
  } catch {
    setState('disconnected', 'Not Connected', 'Start the Browser plugin MCP server');
  }
}

function initUI() {
  var manifest = chrome.runtime.getManifest();
  document.getElementById('titleName').textContent = manifest.name;
  document.getElementById('titleVersion').textContent = 'v' + manifest.version;

  document.getElementById('connectBtn').addEventListener('click', async function () {
    setState('checking', 'Connecting...', 'Connecting to Browser plugin');
    try {
      await chrome.runtime.sendMessage({ type: 'connect' });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setState('disconnected', 'Connection Failed', message);
    } finally {
      await new Promise(function (r) { return setTimeout(r, 800); });
      await checkStatus();
    }
  });

  document.getElementById('settingsBtn').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('openApp').addEventListener('click', function () {
    window.open('duya://open', '_blank');
  });
}

initUI();
checkStatus();
