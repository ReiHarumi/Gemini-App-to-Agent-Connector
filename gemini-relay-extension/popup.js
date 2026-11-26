async function refresh() {
  const pill = document.getElementById("statusPill");
  const enabledLabel = document.getElementById("enabledLabel");
  const pendingLabel = document.getElementById("pendingLabel");
  const toggleBtn = document.getElementById("toggleBtn");
  const meta = document.getElementById("meta");

  const resp = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!resp?.ok) {
    pill.textContent = "Offline";
    pill.className = "pill err";
    return;
  }

  const { settings, health } = resp;
  enabledLabel.textContent = settings.enabled ? "ON" : "OFF";
  toggleBtn.textContent = settings.enabled
    ? "Pause Auto-Trigger"
    : "Enable Auto-Trigger";

  if (health?.status === "ok") {
    pill.textContent = health.webAppBridgeConnected ? "Live" : "Server OK";
    pill.className = "pill ok";
    pendingLabel.textContent = String(health.stats?.pending ?? 0);
  } else {
    pill.textContent = "Server Down";
    pill.className = "pill err";
    pendingLabel.textContent = "-";
  }

  const verLabel = document.getElementById("verLabel");
  if (verLabel) {
    const extVer = chrome.runtime.getManifest().version;
    const srvVer = health?.version ? ` / srv v${health.version}` : "";
    verLabel.textContent = `v${extVer}${srvVer}`;
  }

  const lines = [];
  if (settings.lastTaskId) {
    lines.push(`Last task: ${settings.lastTaskId}`);
  }
  if (settings.lastError) {
    lines.push(`Error: ${settings.lastError}`);
  }
  meta.textContent = lines.join(" • ") || "Keep a gemini.google.com tab open.";
}

document.getElementById("toggleBtn").addEventListener("click", async () => {
  const resp = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  const next = !resp?.settings?.enabled;
  await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: next });
  await refresh();
});

document.getElementById("openBtn").addEventListener("click", async () => {
  await chrome.tabs.create({ url: "https://gemini.google.com/devmode" });
});

void refresh();
