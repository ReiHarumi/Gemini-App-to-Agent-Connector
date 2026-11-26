(() => {
  const POLL_INTERVAL_MS = 1000;
  let isBusy = false;

  const TOOL_LABELS = {
    deep_research: "Deep research",
    create_image: "Create image",
    create_video: "Create video",
    create_music: "Create music",
    guided_learning: "Guided learning",
  };

  const CHAT_MODEL_LABELS = {
    auto: "Auto",
    "4_hydrogen": "4 Hydrogen",
    "4_neon": "4 Neon",
    hydrogen: "4 Hydrogen",
    neon: "4 Neon",
  };

  const TASK_MODEL_LABELS = {
    hydrogen: "Hydrogen",
    "4_hydrogen": "Hydrogen",
    neon: "Neon",
    "4_neon": "Neon",
    auto: "Hydrogen",
  };

  const THINKING_LABELS = {
    low: "Low",
    medium: "Medium",
    high: "High",
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findComposer() {
    const selectors = [
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder*="Describe a task" i]',
      'textarea[aria-label*="prompt" i]',
      "textarea",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (isVisible(el)) return el;
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      "button.send-button",
      'button[aria-label*="Send message" i]',
      'button[aria-label*="Send" i]',
      'button[mattooltip*="Send" i]',
      'button[data-test-id="send-button"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (isVisible(btn) && !btn.disabled) return btn;
    }
    return null;
  }

  function isGeminiGenerating() {
    const stopBtn = document.querySelector(
      'button[aria-label*="Stop response" i], button[aria-label*="Stop generating" i], button.stop-button'
    );
    return isVisible(stopBtn);
  }

  function findButtonByText(textMatch, root = document) {
    const target = textMatch.toLowerCase();
    const candidates = Array.from(
      root.querySelectorAll(
        'button, [role="menuitem"], [role="option"], [role="button"], [role="tab"], mat-list-item, .mat-mdc-menu-item'
      )
    );
    let fallback = null;
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (txt === target) return el;
      if (!fallback && txt.includes(target) && txt.length < target.length + 40) {
        fallback = el;
      }
    }
    return fallback;
  }

  function findOverlayItemByText(textMatch) {
    const overlay = document.querySelector(".cdk-overlay-container");
    if (!overlay) return null;
    const target = textMatch.toLowerCase();
    const all = Array.from(overlay.querySelectorAll("*"));
    let best = null;
    let bestLen = Infinity;
    for (const el of all) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!txt || txt.length > target.length + 50) continue;
      if (txt === target || txt.includes(target)) {
        if (txt.length < bestLen) {
          best = el;
          bestLen = txt.length;
        }
      }
    }
    if (!best) return null;
    return (
      best.closest(
        'button, [role="menuitem"], [role="option"], [role="button"], [tabindex], mat-list-item, .mat-mdc-menu-item, li'
      ) || best
    );
  }

  /**
   * Auto-dismisses the "Choose an app" DevMode modal by selecting "Local Agent Connector"
   * so telemetry stays attached and the composer/Task toggle is unblocked.
   */
  async function dismissChooseAppModal() {
    const overlay = document.querySelector(".cdk-overlay-container");
    if (!overlay) return false;
    const overlayText = (overlay.innerText || "").toLowerCase();
    if (!overlayText.includes("choose an app")) return false;

    const preferred =
      findOverlayItemByText("Localized AI Agent") ||
      findOverlayItemByText("Local Agent Connector") ||
      findOverlayItemByText("Cancel");
    if (preferred) {
      console.log("[Gemini Relay] Auto-selecting connector in Choose an app modal");
      preferred.click();
      await sleep(450);
      return true;
    }
    return false;
  }

  /**
   * Switches between Gemini's "Task" and "Chat" pill toggle below the composer.
   */
  async function selectExecutionMode(mode) {
    if (!mode) return true;
    const targetLabel = mode === "chat" ? "Chat" : "Task";
    // Look for exact "Task" or "Chat" pill button outside the overlay
    const buttons = Array.from(
      document.querySelectorAll('button, [role="tab"], [role="radio"], [role="button"]')
    );
    const pill = buttons.find((el) => {
      if (!isVisible(el) || el.closest(".cdk-overlay-container")) return false;
      const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
      return txt === targetLabel;
    });

    if (pill) {
      const pressed =
        pill.getAttribute("aria-pressed") === "true" ||
        pill.getAttribute("aria-selected") === "true" ||
        pill.getAttribute("aria-checked") === "true";
      if (!pressed) {
        pill.click();
        await sleep(400);
        console.log(`[Gemini Relay] Switched execution mode to: ${targetLabel}`);
      }
      return true;
    }

    console.debug(`[Gemini Relay] Mode pill "${targetLabel}" not visible (may already be inside a thread).`);
    return false;
  }

  function findToolsButton() {
    const directSelectors = [
      "toolbox-drawer button",
      "button.toolbox-drawer-button",
      'button[aria-label*="Tools" i]',
      'button[mattooltip*="Tools" i]',
      'button[aria-label*="Add" i]',
      'button[aria-label*="More options" i]',
      'button[data-test-id*="tool" i]',
    ];
    for (const sel of directSelectors) {
      const btn = document.querySelector(sel);
      if (isVisible(btn)) return btn;
    }
    return findButtonByText("Tools") || findButtonByText("+");
  }

  async function selectGeminiTool(toolKey) {
    const label = TOOL_LABELS[toolKey];
    if (!label) return true;

    const composerArea =
      document.querySelector("input-container, .input-area-container, form") || document;
    const activeChip = findButtonByText(label, composerArea);
    if (activeChip && !activeChip.closest(".cdk-overlay-container")) {
      console.log(`[Gemini Relay] Tool "${label}" is already active.`);
      return true;
    }

    const toolsBtn = findToolsButton();
    if (!toolsBtn) {
      console.warn("[Gemini Relay] Tools/+ button not found on page.");
      return false;
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);

    toolsBtn.click();

    const needsSubmenu = toolKey === "deep_research" || toolKey === "guided_learning";
    let hoveredMoreTools = false;
    let clickedMoreTools = false;

    for (let i = 0; i < 18; i++) {
      await sleep(200);

      const item = findOverlayItemByText(label);
      if (item) {
        item.click();
        await sleep(350);
        console.log(`[Gemini Relay] Selected Gemini Tool: "${label}"`);
        return true;
      }

      if (needsSubmenu) {
        const moreBtn = findOverlayItemByText("More tools");
        if (moreBtn && !hoveredMoreTools) {
          moreBtn.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
          moreBtn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          moreBtn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          hoveredMoreTools = true;
          await sleep(400);
          continue;
        }
        if (moreBtn && hoveredMoreTools && !clickedMoreTools) {
          moreBtn.click();
          clickedMoreTools = true;
          await sleep(400);
          continue;
        }
      }
    }

    const overlay = document.querySelector(".cdk-overlay-container");
    const visibleText = overlay
      ? (overlay.innerText || "").replace(/\s+/g, " ").slice(0, 300)
      : "no overlay";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    console.warn(
      `[Gemini Relay] Opened Tools menu but could not find "${label}". Overlay text: ${visibleText}`
    );
    return false;
  }

  function findModelPickerButton() {
    const directSelectors = [
      "bard-mode-switcher button",
      'button[data-test-id*="model" i]',
      'button[aria-label*="model" i]',
    ];
    for (const sel of directSelectors) {
      const btn = document.querySelector(sel);
      if (isVisible(btn)) return btn;
    }
    return (
      findButtonByText("Hydrogen") ||
      findButtonByText("Neon") ||
      findButtonByText("4 Hydrogen") ||
      findButtonByText("4 Neon") ||
      findButtonByText("Everyday help") ||
      findButtonByText("Deeper analysis") ||
      findButtonByText("Auto")
    );
  }

  async function selectGeminiModelAndThinking(webModel, thinkingLevel, executionMode = "task") {
    if (!webModel && !thinkingLevel) return { ok: true, skipped: true };
    const picker = findModelPickerButton();
    if (!picker) {
      console.warn("[Gemini Relay] Model picker button not found.");
      return { ok: false, error: "Model picker button not found" };
    }

    const result = {
      ok: true,
      executionMode,
      modelSelected: null,
      thinkingSelected: null,
    };

    const labelMap = executionMode === "task" ? TASK_MODEL_LABELS : CHAT_MODEL_LABELS;
    if (webModel && labelMap[webModel]) {
      const targetModel = labelMap[webModel];
      const currentPickerText = (picker.innerText || "").toLowerCase();
      // Speedup: skip opening the model dropdown if the requested model is already active!
      if (currentPickerText.includes(targetModel.toLowerCase())) {
        result.modelSelected = `${targetModel} (already active)`;
      } else {
        picker.click();
        for (let i = 0; i < 10; i++) {
          await sleep(120);
          const item = findOverlayItemByText(targetModel);
          if (item) {
            item.click();
            result.modelSelected = targetModel;
            await sleep(250);
            break;
          }
        }
      }
    }

    // Thinking level only exists in Chat mode (Task mode only has Neon / Hydrogen)
    if (executionMode === "chat" && thinkingLevel && THINKING_LABELS[thinkingLevel]) {
      const pickerAgain = findModelPickerButton();
      if (pickerAgain) {
        pickerAgain.click();
        let openedThinking = false;
        const targetThinking = THINKING_LABELS[thinkingLevel];
        for (let i = 0; i < 12; i++) {
          await sleep(160);
          if (!openedThinking) {
            const tlBtn = findOverlayItemByText("Thinking level");
            if (tlBtn) {
              tlBtn.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
              tlBtn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
              tlBtn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              tlBtn.click();
              openedThinking = true;
              await sleep(300);
              continue;
            }
          }
          const levelBtn = findOverlayItemByText(targetThinking);
          if (levelBtn) {
            levelBtn.click();
            result.thinkingSelected = targetThinking;
            await sleep(250);
            break;
          }
        }
      }
    }

    console.log("[Gemini Relay] Mode set:", result);
    return result;
  }

  async function injectAndSend(text) {
    const composer = findComposer();
    if (!composer) return false;

    composer.focus();

    if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
      composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);

      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) composer.textContent = text;
      composer.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
      );
    }

    await sleep(350);

    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
      return true;
    }

    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      })
    );
    return true;
  }

  function getLatestResponseText() {
    const containers = Array.from(
      document.querySelectorAll(
        "model-response, message-content, .model-response-text, .markdown"
      )
    );
    if (containers.length === 0) return "";
    const last = containers[containers.length - 1];
    return (last.innerText || last.textContent || "").trim();
  }

  async function waitUntilGenerationFinishes(maxWaitMs = 120_000) {
    await sleep(2500);
    const start = Date.now();
    let idleStreak = 0;
    while (Date.now() - start < maxWaitMs) {
      if (isGeminiGenerating()) {
        idleStreak = 0;
      } else {
        idleStreak++;
        if (idleStreak >= 3) return true;
      }
      await sleep(1000);
    }
    return false;
  }

  function snapshotMediaUrls() {
    const urls = new Set();
    document.querySelectorAll("img, video, audio, source").forEach((el) => {
      if (el.src) urls.add(el.src);
    });
    return urls;
  }

  function findNewMediaElement(kind, previousUrls) {
    if (kind === "create_image") {
      const imgs = Array.from(document.querySelectorAll("img")).reverse();
      for (const img of imgs) {
        if (!img.src || previousUrls.has(img.src)) continue;
        if (img.naturalWidth >= 200 && img.naturalHeight >= 200) {
          return { src: img.src, fallbackMime: "image/png" };
        }
      }
    }
    if (kind === "create_video") {
      const vids = Array.from(document.querySelectorAll("video, video source")).reverse();
      for (const v of vids) {
        if (v.src && !previousUrls.has(v.src)) {
          return { src: v.src, fallbackMime: "video/mp4" };
        }
      }
    }
    if (kind === "create_music") {
      const auds = Array.from(document.querySelectorAll("audio, audio source")).reverse();
      for (const a of auds) {
        if (a.src && !previousUrls.has(a.src)) {
          return { src: a.src, fallbackMime: "audio/mpeg" };
        }
      }
    }
    return null;
  }

  async function fetchUrlAsBase64(url, fallbackMime) {
    const res = await fetch(url, { credentials: "include" });
    const blob = await res.blob();
    const mimeType = blob.type || fallbackMime;
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = String(reader.result || "");
        const idx = dataUrl.indexOf(",");
        resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return { base64, mimeType };
  }

  async function handleDeepResearchPlan(task) {
    await selectExecutionMode("chat");
    const selected = await selectGeminiTool("deep_research");
    if (!selected) {
      await chrome.runtime.sendMessage({
        type: "POST_COMPLETE",
        taskId: task.id,
        error:
          "Could not select 'Deep research' under Tools -> More tools. Aborted instead of sending as normal chat.",
      });
      return;
    }
    await injectAndSend(task.triggerPrompt);

    const start = Date.now();
    while (Date.now() - start < 60_000) {
      await sleep(1500);
      const startBtn = findButtonByText("Start research");
      if (startBtn) {
        await sleep(800);
        const planText = getLatestResponseText() || "Research plan ready in Gemini Web App.";
        await chrome.runtime.sendMessage({
          type: "POST_PLAN",
          taskId: task.id,
          plan: planText,
        });
        console.log("[Gemini Relay] Relayed Deep Research plan for", task.id);
        return;
      }
    }

    const fallbackText = getLatestResponseText();
    await chrome.runtime.sendMessage({
      type: "POST_PLAN",
      taskId: task.id,
      plan: fallbackText || "Plan card not detected — check Gemini Web App tab.",
    });
  }

  async function handleDeepResearchApprove(task) {
    const startBtn = findButtonByText("Start research");
    if (!startBtn) {
      await chrome.runtime.sendMessage({
        type: "POST_COMPLETE",
        taskId: task.id,
        error: "Could not find 'Start research' button in the active Gemini tab.",
      });
      return;
    }

    startBtn.click();
    console.log("[Gemini Relay] Clicked 'Start research' for", task.id);

    await waitUntilGenerationFinishes(480_000);
    const report = getLatestResponseText();
    await chrome.runtime.sendMessage({
      type: "POST_COMPLETE",
      taskId: task.id,
      result: report || "Deep Research completed (check Gemini tab for full output).",
      meta: { geminiTool: "deep_research" },
    });
  }

  async function handleMediaGeneration(task) {
    const beforeUrls = snapshotMediaUrls();
    await selectExecutionMode(task.executionMode || "task");
    await selectGeminiTool(task.geminiTool);
    await injectAndSend(task.triggerPrompt);

    await waitUntilGenerationFinishes(180_000);

    // Wait up to 45s for the generated media element to finish rendering (especially in Task mode)
    let media = null;
    for (let i = 0; i < 30; i++) {
      media = findNewMediaElement(task.geminiTool, beforeUrls);
      if (media) break;
      await sleep(1500);
    }
    if (!media) {
      await chrome.runtime.sendMessage({
        type: "POST_COMPLETE",
        taskId: task.id,
        result: getLatestResponseText() || "Generation finished, but no media element was detected.",
        meta: { geminiTool: task.geminiTool, mediaCaptured: false },
      });
      return;
    }

    try {
      const { base64, mimeType } = await fetchUrlAsBase64(media.src, media.fallbackMime);
      await chrome.runtime.sendMessage({
        type: "POST_MEDIA",
        taskId: task.id,
        base64,
        mimeType,
        caption: getLatestResponseText().slice(0, 500),
      });
      console.log("[Gemini Relay] Uploaded generated media for", task.id);
    } catch (err) {
      await chrome.runtime.sendMessage({
        type: "POST_COMPLETE",
        taskId: task.id,
        error: `Media generated but upload failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function executeAssignedTask(bridgeAction, task) {
    if (isBusy) return;
    isBusy = true;
    try {
      await dismissChooseAppModal();
      const execMode = task.executionMode || "task";
      console.log("[Gemini Relay] Executing:", bridgeAction, task.id, `[${execMode}]`, task.geminiTool || "");

      if (bridgeAction === "set_mode") {
        await selectExecutionMode(execMode);
        const res = await selectGeminiModelAndThinking(task.webModel, task.thinkingLevel, execMode);
        await chrome.runtime.sendMessage({
          type: "POST_COMPLETE",
          taskId: task.id,
          result: JSON.stringify(res),
          meta: { bridgeAction: "set_mode", ...res },
        });
        return;
      }

      if (bridgeAction === "approve_deep_research") {
        await handleDeepResearchApprove(task);
        return;
      }

      // Switch to Task or Chat mode first, then apply requested model
      await selectExecutionMode(execMode);
      if (
        !task.geminiTool ||
        task.geminiTool === "deep_research" ||
        task.geminiTool === "guided_learning"
      ) {
        await selectGeminiModelAndThinking(task.webModel, task.thinkingLevel, execMode);
      }

      if (task.geminiTool === "deep_research") {
        await handleDeepResearchPlan(task);
        return;
      }

      if (
        task.geminiTool === "create_image" ||
        task.geminiTool === "create_video" ||
        task.geminiTool === "create_music"
      ) {
        await handleMediaGeneration(task);
        return;
      }

      if (task.geminiTool === "guided_learning") {
        await selectGeminiTool("guided_learning");
        await injectAndSend(task.triggerPrompt);
        await waitUntilGenerationFinishes(90_000);
        await chrome.runtime.sendMessage({
          type: "POST_COMPLETE",
          taskId: task.id,
          result: getLatestResponseText(),
          meta: { geminiTool: "guided_learning" },
        });
        return;
      }

      // Standard MCP relay task in Task mode (Gemini calls relay_submit_result itself)
      await injectAndSend(task.triggerPrompt);
      await waitUntilGenerationFinishes(180_000);
    } catch (err) {
      console.error("[Gemini Relay] Execution error:", err);
    } finally {
      isBusy = false;
      chrome.runtime.sendMessage({ type: "TASK_DONE" }).catch(() => {});
    }
  }

  // Event-driven message listener from background.js SSE dispatcher (zero background throttling!)
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING_READY") {
      (async () => {
        await dismissChooseAppModal();
        sendResponse({
          ready: Boolean(findComposer()),
          generating: isBusy || isGeminiGenerating(),
        });
      })();
      return true;
    }

    if (message?.type === "EXECUTE_TASK" && message.task) {
      sendResponse({ accepted: true });
      void executeAssignedTask(message.bridgeAction, message.task);
      return false;
    }
    return false;
  });

  // Dismiss "Choose an app" modal immediately on page load
  setTimeout(() => {
    void dismissChooseAppModal();
  }, 1500);

  console.log("[Gemini Relay] Bridge content script v2.2.0 (SSE push + parallel) active on", window.location.href);
})();
