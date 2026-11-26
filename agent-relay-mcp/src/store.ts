import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "awaiting_approval"
  | "completed"
  | "failed";

export type TaskCapability =
  | "general"
  | "google-photos"
  | "local-files"
  | "workspace"
  | "browser"
  | "deep-research"
  | "create-image"
  | "create-video"
  | "create-music"
  | "guided-learning";

export type GeminiWebTool =
  | "deep_research"
  | "create_image"
  | "create_video"
  | "create_music"
  | "guided_learning"
  | "set_mode";

export type GeminiExecutionMode = "task" | "chat";
export type GeminiWebModel = "auto" | "4_hydrogen" | "4_neon" | "hydrogen" | "neon";
export type GeminiThinkingLevel = "low" | "medium" | "high";

export interface RelayTask {
  id: string;
  fromAgent: string;
  toAgent: string;
  capability: TaskCapability;
  executionMode?: GeminiExecutionMode;
  geminiTool?: GeminiWebTool;
  webModel?: GeminiWebModel;
  thinkingLevel?: GeminiThinkingLevel;
  prompt: string;
  context?: Record<string, unknown>;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  claimedBy?: string;
  researchPlan?: string;
  approvalAction?: "approve" | "cancel";
  result?: string;
  resultData?: Record<string, unknown>;
  error?: string;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "relay-store.json");
const MAX_TASKS = 500;

class RelayStore {
  private tasks = new Map<string, RelayTask>();
  private events = new EventEmitter();
  private lastBridgeHeartbeat = 0;

  onBridgeEvent(listener: () => void): () => void {
    this.events.on("bridge:ready", listener);
    return () => this.events.off("bridge:ready", listener);
  }

  private notifyBridge(): void {
    this.events.emit("bridge:ready");
  }

  recordBridgeHeartbeat(): void {
    this.lastBridgeHeartbeat = Date.now();
  }

  isWebAppBridgeConnected(): boolean {
    return Date.now() - this.lastBridgeHeartbeat < 15_000;
  }

  claimNextForBridge(): {
    action: "dispatch" | "approve_deep_research";
    task: RelayTask;
  } | null {
    this.recordBridgeHeartbeat();
    const now = Date.now();

    // Priority 1: Approved Deep Research waiting for "Start research" click
    const approved = Array.from(this.tasks.values()).find((t) => {
      if (t.status !== "awaiting_approval" || t.approvalAction !== "approve") {
        return false;
      }
      if (!t.dispatchedAt) return true;
      return now - new Date(t.dispatchedAt).getTime() > 90_000;
    });
    if (approved) {
      approved.dispatchedAt = new Date().toISOString();
      approved.status = "in_progress";
      approved.updatedAt = approved.dispatchedAt;
      this.save();
      return { action: "approve_deep_research", task: approved };
    }

    // Priority 2: Normal pending gemini-app tasks
    const candidates = Array.from(this.tasks.values()).filter((t) => {
      if (t.status !== "pending") return false;
      if (t.toAgent !== "gemini-app") return false;
      if (!t.dispatchedAt) return true;
      // Retry dispatch if 90s elapsed without Gemini picking it up
      return now - new Date(t.dispatchedAt).getTime() > 90_000;
    });

    if (candidates.length === 0) return null;
    const next = candidates[0];
    next.dispatchedAt = new Date().toISOString();
    next.updatedAt = next.dispatchedAt;
    this.save();
    return { action: "dispatch", task: next };
  }

  submitResearchPlan(taskId: string, planText: string): RelayTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);
    task.status = "awaiting_approval";
    task.researchPlan = planText;
    task.dispatchedAt = undefined;
    task.updatedAt = new Date().toISOString();
    this.save();
    this.events.emit(`plan:${task.id}`, task);
    return task;
  }

  approveDeepResearch(taskId: string, approved: boolean): RelayTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found.`);
    if (!approved) {
      task.approvalAction = "cancel";
      task.status = "failed";
      task.error = "Deep Research plan cancelled by user before starting.";
      task.updatedAt = new Date().toISOString();
      this.save();
      this.events.emit(`done:${task.id}`, task);
      return task;
    }
    task.approvalAction = "approve";
    task.dispatchedAt = undefined;
    task.updatedAt = new Date().toISOString();
    this.save();
    this.notifyBridge();
    return task;
  }

  async waitForPlan(taskId: string, waitSeconds: number): Promise<{
    timedOut: boolean;
    task: RelayTask;
  }> {
    const existing = this.tasks.get(taskId);
    if (!existing) throw new Error(`Task "${taskId}" not found.`);
    if (
      existing.status === "awaiting_approval" ||
      existing.status === "completed" ||
      existing.status === "failed"
    ) {
      return { timedOut: false, task: existing };
    }
    const ms = Math.max(0, Math.min(waitSeconds, 120)) * 1000;
    if (ms === 0) return { timedOut: true, task: existing };

    return new Promise((resolve) => {
      const planEv = `plan:${taskId}`;
      const doneEv = `done:${taskId}`;
      const timer = setTimeout(() => {
        this.events.off(planEv, onReady);
        this.events.off(doneEv, onReady);
        resolve({ timedOut: true, task: this.tasks.get(taskId) ?? existing });
      }, ms);

      const onReady = (t: RelayTask) => {
        clearTimeout(timer);
        this.events.off(planEv, onReady);
        this.events.off(doneEv, onReady);
        resolve({ timedOut: false, task: t });
      };

      this.events.once(planEv, onReady);
      this.events.once(doneEv, onReady);
    });
  }

  constructor() {
    this.events.setMaxListeners(100);
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(STORE_PATH)) return;
      const raw = fs.readFileSync(STORE_PATH, "utf8");
      const parsed = JSON.parse(raw) as RelayTask[];
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          this.tasks.set(t.id, t);
        }
      }
    } catch (err) {
      console.error("Failed to load relay store:", err);
    }
  }

  private save(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const list = Array.from(this.tasks.values()).slice(-MAX_TASKS);
      fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to persist relay store:", err);
    }
  }

  createTask(input: {
    fromAgent: string;
    toAgent: string;
    capability?: TaskCapability;
    executionMode?: GeminiExecutionMode;
    geminiTool?: GeminiWebTool;
    webModel?: GeminiWebModel;
    thinkingLevel?: GeminiThinkingLevel;
    prompt: string;
    context?: Record<string, unknown>;
  }): RelayTask {
    const now = new Date().toISOString();
    const id = `task-${crypto.randomBytes(4).toString("hex")}`;
    const task: RelayTask = {
      id,
      fromAgent: input.fromAgent.trim() || "unknown",
      toAgent: input.toAgent.trim().toLowerCase(),
      capability: input.capability ?? "general",
      executionMode: input.executionMode,
      geminiTool: input.geminiTool,
      webModel: input.webModel,
      thinkingLevel: input.thinkingLevel,
      prompt: input.prompt,
      context: input.context,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    this.prune();
    this.save();
    if (task.toAgent === "gemini-app") {
      this.notifyBridge();
    }
    return task;
  }

  private prune(): void {
    if (this.tasks.size <= MAX_TASKS) return;
    const keys = Array.from(this.tasks.keys());
    for (const k of keys.slice(0, this.tasks.size - MAX_TASKS)) {
      this.tasks.delete(k);
    }
  }

  getTask(id: string): RelayTask | undefined {
    return this.tasks.get(id);
  }

  getPendingTasks(options: {
    forAgent?: string;
    capability?: TaskCapability;
    claim?: boolean;
    claimedBy?: string;
    limit?: number;
  }): RelayTask[] {
    const target = options.forAgent?.trim().toLowerCase();
    const matches = Array.from(this.tasks.values()).filter((t) => {
      if (t.status !== "pending") return false;
      if (target && target !== "all" && t.toAgent !== target && t.toAgent !== "any") {
        return false;
      }
      if (options.capability && t.capability !== options.capability) {
        return false;
      }
      return true;
    });

    const limited = matches.slice(0, options.limit ?? 10);

    if (options.claim && limited.length > 0) {
      const now = new Date().toISOString();
      for (const task of limited) {
        task.status = "in_progress";
        task.claimedBy = options.claimedBy || target || "worker";
        task.updatedAt = now;
      }
      this.save();
    }

    return limited;
  }

  submitResult(input: {
    taskId: string;
    status?: "completed" | "failed";
    result?: string;
    resultData?: Record<string, unknown>;
    error?: string;
  }): RelayTask {
    const task = this.tasks.get(input.taskId);
    if (!task) {
      throw new Error(`Task "${input.taskId}" not found.`);
    }
    task.status = input.status ?? (input.error ? "failed" : "completed");
    task.result = input.result;
    task.resultData = input.resultData;
    task.error = input.error;
    task.updatedAt = new Date().toISOString();
    this.save();
    this.events.emit(`done:${task.id}`, task);
    return task;
  }

  async waitForResult(taskId: string, waitSeconds: number): Promise<{
    timedOut: boolean;
    task: RelayTask;
  }> {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      throw new Error(`Task "${taskId}" not found.`);
    }
    if (existing.status === "completed" || existing.status === "failed") {
      return { timedOut: false, task: existing };
    }
    const ms = Math.max(0, Math.min(waitSeconds, 120)) * 1000;
    if (ms === 0) {
      return { timedOut: true, task: existing };
    }

    return new Promise((resolve) => {
      const eventName = `done:${taskId}`;
      const timer = setTimeout(() => {
        this.events.off(eventName, onDone);
        resolve({ timedOut: true, task: this.tasks.get(taskId) ?? existing });
      }, ms);

      const onDone = (finished: RelayTask) => {
        clearTimeout(timer);
        resolve({ timedOut: false, task: finished });
      };

      this.events.once(eventName, onDone);
    });
  }

  listTasks(options?: {
    status?: TaskStatus;
    toAgent?: string;
    fromAgent?: string;
    capability?: TaskCapability;
    limit?: number;
  }): RelayTask[] {
    let list = Array.from(this.tasks.values());
    if (options?.status) list = list.filter((t) => t.status === options.status);
    if (options?.toAgent) {
      const target = options.toAgent.trim().toLowerCase();
      list = list.filter((t) => t.toAgent === target);
    }
    if (options?.fromAgent) {
      const from = options.fromAgent.trim().toLowerCase();
      list = list.filter((t) => t.fromAgent.toLowerCase() === from);
    }
    if (options?.capability) {
      list = list.filter((t) => t.capability === options.capability);
    }
    return list.slice(-(options?.limit ?? 20)).reverse();
  }

  stats(): Record<string, number> {
    const counts: Record<string, number> = {
      total: this.tasks.size,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    for (const t of this.tasks.values()) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    return counts;
  }
}

export const relayStore = new RelayStore();
