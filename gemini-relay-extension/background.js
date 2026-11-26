const DEFAULT_RELAY_URL = "http://127.0.0.1:3001";
const MAX_CONCURRENT_TABS = 5;
const STREAM_ALARM = "relay-stream-keepalive";

let streamActive = false;
let draining = false;
let needsRedrain = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSettings() {
  return chrome.storage.local.get({
    enabled: true,
    relayUrl: DEFAULT_RELAY_URL,
    lastTaskId: null,
    lastDispatchedAt: null,
    lastError: null,
    knownSignature: null,
  });
}

async function getPoolState() {
  const data = await chrome.storage.session.get({
    busyTabs: {},    // { [tabId]: taskId }
    spawnedTabs: {}, // { [tabId]: true }
  });
  return data;
}

async function setPoolState(busyTabs, spawnedTabs) {
  await chrome.storage.session.set({ busyTabs, spawnedTabs });
}

async function updateBadge(enabled, connected, activeCount = 0) {
  if (!enabled) {
    await chrome.action.setBadgeText({ text: "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    return;
  }
  if (!connected) {
    await chrome.action.setBadgeText({ text: "ERR" });
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    return;
  }
  await chrome.action.setBadgeText({ text: activeCount > 0 ? String(activeCount) : "ON" });
  await chrome.action.setBadgeBackgroundColor({
    color: activeCount > 0 ? "#2563eb" : "#16a34a",
  });
}

async function checkAutoReload(serverSignature, settings) {
  if (!serverSignature) return false;
  if (!settings.knownSignature) {
    await chrome.storage.local.set({ knownSignature: serverSignature });
    return false;
  }
  if (settings.knownSignature !== serverSignature) {
    console.log("[Gemini Relay] Update detected:", settings.knownSignature, "->", serverSignature);
    await chrome.storage.local.set({ knownSignature: serverSignature });
    try {
      const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
      for (const tab of tabs) {
        if (tab.id) chrome.tabs.reload(tab.id).catch(() => {});
      }
    } catch {
      // ignore
    }
    chrome.runtime.reload();
    return true;
  }
  return false;
}

async function waitForTabReady(tabId, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "PING_READY" });
      if (resp?.ready) return true;
    } catch {
      // content script still loading
    }
    await sleep(500);
  }
  return false;
}

async function acquireWorkerTab() {
  const { busyTabs, spawnedTabs } = await getPoolState();
  const openTabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  const openIds = new Set(openTabs.map((t) => String(t.id)));

  // Prune any closed tabs from busyTabs / spawnedTabs
  for (const id of Object.keys(busyTabs)) {
    if (!openIds.has(id)) delete busyTabs[id];
  }
  for (const id of Object.keys(spawnedTabs)) {
    if (!openIds.has(id)) delete spawnedTabs[id];
  }

  // 1. Try to find an idle existing Gemini tab
  for (const tab of openTabs) {
    const key = String(tab.id);
    if (busyTabs[key]) continue;
    try {
      const ping = await chrome.tabs.sendMessage(tab.id, { type: "PING_READY" });
      if (ping?.ready && !ping?.generating) {
        return { tabId: tab.id, busyTabs, spawnedTabs };
      }
    } catch {
      // Tab not responsive yet
    }
  }

  // 2. Otherwise spawn a new background worker tab if under concurrency cap
  if (Object.keys(busyTabs).length >= MAX_CONCURRENT_TABS) {
    return null;
  }

  const created = await chrome.tabs.create({
    url: "https://gemini.google.com/devmode",
    active: false,
  });
  if (!created.id) return null;

  spawnedTabs[String(created.id)] = true;
  await setPoolState(busyTabs, spawnedTabs);

  const ready = await waitForTabReady(created.id, 22_000);
  if (!ready) {
    console.warn("[Gemini Relay] Spawned tab did not become ready:", created.id);
    return null;
  }

  return { tabId: created.id, busyTabs, spawnedTabs };
}

async function drainPendingTasks() {
  if (draining) {
    needsRedrain = true;
    return;
  }
  draining = true;
  needsRedrain = false;
  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      await updateBadge(false, false);
      return;
    }

    // Pull tasks up to MAX_CONCURRENT_TABS in parallel!
    for (let i = 0; i < MAX_CONCURRENT_TABS; i++) {
      const pool = await getPoolState();
      if (Object.keys(pool.busyTabs).length >= MAX_CONCURRENT_TABS) break;

      const res = await fetch(`${settings.relayUrl}/bridge/next`, {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) break;

      const json = await res.json();
      if (await checkAutoReload(json.extensionSignature, settings)) return;

      if (!json.hasTask || !json.task) {
        await updateBadge(true, true, Object.keys(pool.busyTabs).length);
        break;
      }

      const slot = await acquireWorkerTab();
      if (!slot) break;

      const { tabId, busyTabs, spawnedTabs } = slot;
      busyTabs[String(tabId)] = json.task.id;
      await setPoolState(busyTabs, spawnedTabs);
      await chrome.storage.local.set({
        lastTaskId: json.task.id,
        lastDispatchedAt: new Date().toISOString(),
        lastError: null,
      });
      await updateBadge(true, true, Object.keys(busyTabs).length);

      // Fire and forget into the worker tab so multiple tabs run concurrently!
      chrome.tabs
        .sendMessage(tabId, {
          type: "EXECUTE_TASK",
          bridgeAction: json.bridgeAction,
          task: json.task,
        })
        .catch(async (err) => {
          console.warn("[Gemini Relay] Failed to send task to tab", tabId, err);
          const cur = await getPoolState();
          delete cur.busyTabs[String(tabId)];
          await setPoolState(cur.busyTabs, cur.spawnedTabs);
        });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await chrome.storage.local.set({ lastError: msg });
    await updateBadge(true, false);
  } finally {
    draining = false;
    if (needsRedrain) {
      needsRedrain = false;
      void drainPendingTasks();
    }
  }
}

/**
 * Persistent SSE push stream from agent-relay-mcp (127.0.0.1:3001/bridge/stream).
 * Runs inside the MV3 Service Worker so Chrome NEVER throttles it when minimized or hidden!
 */
async function startSseStream() {
  if (streamActive) return;
  streamActive = true;
  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      await updateBadge(false, false);
      return;
    }

    const res = await fetch(`${settings.relayUrl}/bridge/stream`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
    });

    if (!res.ok || !res.body) {
      await updateBadge(true, false);
      return;
    }

    const pool = await getPoolState();
    await updateBadge(true, true, Object.keys(pool.busyTabs).length);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        const eventType = eventLine ? eventLine.slice(6).trim() : "message";
        let payload = {};
        if (dataLine) {
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            // ignore
          }
        }

        const curSettings = await getSettings();
        if (payload.extensionSignature) {
          if (await checkAutoReload(payload.extensionSignature, curSettings)) return;
        }

        if (eventType === "task_available" || eventType === "ready") {
          void drainPendingTasks();
        }
      }
    }
  } catch (err) {
    console.debug("[Gemini Relay] SSE stream disconnected, will reconnect:", err);
    await updateBadge(true, false);
  } finally {
    streamActive = false;
  }
}

async function ensureKeepalive() {
  const existing = await chrome.alarms.get(STREAM_ALARM);
  if (!existing) {
    await chrome.alarms.create(STREAM_ALARM, { periodInMinutes: 0.5 });
  }
  void startSseStream();
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureKeepalive();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureKeepalive();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === STREAM_ALARM) {
    void startSseStream();
    void drainPendingTasks();
    return;
  }
  if (alarm.name.startsWith("close-tab-")) {
    const tabId = Number(alarm.name.replace("close-tab-", ""));
    const { busyTabs, spawnedTabs } = await getPoolState();
    if (!busyTabs[String(tabId)] && spawnedTabs[String(tabId)]) {
      delete spawnedTabs[String(tabId)];
      await setPoolState(busyTabs, spawnedTabs);
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { busyTabs, spawnedTabs } = await getPoolState();
  const key = String(tabId);
  if (busyTabs[key] || spawnedTabs[key]) {
    delete busyTabs[key];
    delete spawnedTabs[key];
    await setPoolState(busyTabs, spawnedTabs);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();

      if (message?.type === "TASK_DONE") {
        const tabId = sender.tab?.id;
        if (tabId) {
          const { busyTabs, spawnedTabs } = await getPoolState();
          const key = String(tabId);
          delete busyTabs[key];
          await setPoolState(busyTabs, spawnedTabs);
          await updateBadge(settings.enabled, true, Object.keys(busyTabs).length);

          // Auto-close extra spawned worker tabs 15s after completion
          if (spawnedTabs[key]) {
            await chrome.alarms.create(`close-tab-${tabId}`, { delayInMinutes: 0.25 });
          }
          // Check if more tasks are waiting in queue
          void drainPendingTasks();
        }
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === "POST_PLAN") {
        const res = await fetch(`${settings.relayUrl}/bridge/plan/${message.taskId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: message.plan }),
        });
        sendResponse({ ok: res.ok, status: res.status });
        return;
      }

      if (message?.type === "POST_COMPLETE") {
        const res = await fetch(`${settings.relayUrl}/bridge/complete/${message.taskId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            result: message.result,
            error: message.error,
            meta: message.meta,
          }),
        });
        sendResponse({ ok: res.ok, status: res.status });
        return;
      }

      if (message?.type === "POST_MEDIA") {
        const res = await fetch(`${settings.relayUrl}/bridge/upload/${message.taskId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base64: message.base64,
            mimeType: message.mimeType,
            caption: message.caption,
          }),
        });
        sendResponse({ ok: res.ok, status: res.status });
        return;
      }

      if (message?.type === "GET_STATUS") {
        void ensureKeepalive();
        let health = null;
        try {
          const res = await fetch(`${settings.relayUrl}/health`, { cache: "no-store" });
          if (res.ok) health = await res.json();
        } catch {
          health = null;
        }
        const pool = await getPoolState();
        await updateBadge(settings.enabled, Boolean(health), Object.keys(pool.busyTabs).length);
        sendResponse({ ok: true, settings, health, activeTabs: Object.keys(pool.busyTabs).length });
        return;
      }

      if (message?.type === "SET_ENABLED") {
        const enabled = Boolean(message.enabled);
        await chrome.storage.local.set({ enabled });
        if (enabled) void ensureKeepalive();
        await updateBadge(enabled, enabled);
        sendResponse({ ok: true, enabled });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await chrome.storage.local.set({ lastError: msg });
      sendResponse({ ok: false, error: msg });
    }
  })();
  return true;
});

// Boot stream immediately when service worker wakes
void ensureKeepalive();
