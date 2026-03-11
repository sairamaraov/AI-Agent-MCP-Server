import { v4 as uuidv4 } from "uuid";
import { RedisClient } from "../redis-client.js";
import type { Task, TaskStatus, TaskEvent, Priority, TaskNote } from "../types.js";

const KEYS = {
  TASK: (id: string) => `tasks:${id}`,
  TASK_EVENTS: (id: string) => `tasks:${id}:events`,
  BY_STATUS: (status: string) => `tasks:by-status:${status}`,
  BY_AGENT: (agentId: string) => `tasks:by-agent:${agentId}`,
  BY_REPORTER: (agentId: string) => `tasks:by-reporter:${agentId}`,
  ALL_TASKS: "tasks:all",
};

/**
 * Safely parse JSON with a fallback value.
 * Prevents crashes from malformed JSON data in Redis.
 */
function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class TaskTools {
  constructor(private redis: RedisClient) {}

  /**
   * Create a new task
   */
  async create(params: {
    title: string;
    description: string;
    priority?: Priority;
    assignee?: string;
    reporter: string;
    dependencies?: string[];
  }): Promise<{ taskId: string; task: Task }> {
    const now = Date.now();
    const taskId = `task-${uuidv4().slice(0, 8)}`;

    const task: Task = {
      id: taskId,
      title: params.title,
      description: params.description,
      status: params.assignee ? "assigned" : "pending",
      priority: params.priority || "normal",
      assignee: params.assignee,
      reporter: params.reporter,
      dependencies: params.dependencies || [],
      blockedBy: [],
      artifacts: [],
      notes: [],
      createdAt: now,
      updatedAt: now,
    };

    // Store task as hash
    await this.redis.hset(KEYS.TASK(taskId), "id", taskId);
    await this.redis.hset(KEYS.TASK(taskId), "title", task.title);
    await this.redis.hset(KEYS.TASK(taskId), "description", task.description);
    await this.redis.hset(KEYS.TASK(taskId), "status", task.status);
    await this.redis.hset(KEYS.TASK(taskId), "priority", task.priority);
    await this.redis.hset(KEYS.TASK(taskId), "assignee", task.assignee || "");
    await this.redis.hset(KEYS.TASK(taskId), "reporter", task.reporter);
    await this.redis.hset(KEYS.TASK(taskId), "dependencies", JSON.stringify(task.dependencies));
    await this.redis.hset(KEYS.TASK(taskId), "blockedBy", JSON.stringify(task.blockedBy));
    await this.redis.hset(KEYS.TASK(taskId), "artifacts", JSON.stringify(task.artifacts));
    await this.redis.hset(KEYS.TASK(taskId), "notes", JSON.stringify(task.notes));
    await this.redis.hset(KEYS.TASK(taskId), "createdAt", String(now));
    await this.redis.hset(KEYS.TASK(taskId), "updatedAt", String(now));

    // Add to indexes
    await this.redis.sadd(KEYS.ALL_TASKS, taskId);
    await this.redis.sadd(KEYS.BY_STATUS(task.status), taskId);
    await this.redis.sadd(KEYS.BY_REPORTER(params.reporter), taskId);
    
    if (params.assignee) {
      await this.redis.sadd(KEYS.BY_AGENT(params.assignee), taskId);
    }

    // Record event
    await this.addEvent(taskId, params.reporter, "created", `Task created: ${task.title}`);

    // Publish task event
    await this.redis.publish("events:task", JSON.stringify({
      type: "task_created",
      task: task,
      timestamp: now,
    }));

    // Notify assignee if assigned
    if (params.assignee) {
      await this.redis.publish(`notify:${params.assignee}`, JSON.stringify({
        type: "task_assigned",
        task: task,
      }));
    }

    return { taskId, task };
  }

  /**
   * Update a task with optimistic locking to prevent race conditions.
   * If another agent modifies the task between read and write, this will detect it.
   */
  async update(params: {
    taskId: string;
    agentId: string;
    status?: TaskStatus;
    assignee?: string;
    blockedBy?: string[];
    artifacts?: string[];
    notes?: string;
    priority?: Priority;
  }): Promise<{ success: boolean; task: Task; notifiedAgents: string[] }> {
    const now = Date.now();
    const taskData = await this.redis.hgetall(KEYS.TASK(params.taskId));

    if (!taskData.id) {
      throw new Error(`Task not found: ${params.taskId}`);
    }

    // Store the version for optimistic locking
    const expectedVersion = taskData.updatedAt;

    const oldStatus = taskData.status;
    const oldAssignee = taskData.assignee;
    const notifiedAgents: string[] = [];
    const changes: string[] = [];

    // Prepare all updates
    const hashUpdates: Record<string, string> = {
      updatedAt: String(now),
    };

    // Update status
    if (params.status && params.status !== oldStatus) {
      hashUpdates.status = params.status;
      changes.push(`status: ${oldStatus} → ${params.status}`);

      if (params.status === "completed") {
        hashUpdates.completedAt = String(now);
      }
    }

    // Update assignee
    if (params.assignee !== undefined && params.assignee !== oldAssignee) {
      hashUpdates.assignee = params.assignee || "";
      notifiedAgents.push(params.assignee || "");
      changes.push(`assignee: ${oldAssignee || "unassigned"} → ${params.assignee || "unassigned"}`);
    }

    // Update blockedBy
    if (params.blockedBy !== undefined) {
      hashUpdates.blockedBy = JSON.stringify(params.blockedBy);
      if (params.blockedBy.length > 0) {
        changes.push(`blocked by: ${params.blockedBy.join(", ")}`);
      }
    }

    // Update artifacts (safe JSON parsing)
    if (params.artifacts !== undefined) {
      const currentArtifacts = safeJsonParse<string[]>(taskData.artifacts, []);
      const newArtifacts = [...new Set([...currentArtifacts, ...params.artifacts])];
      hashUpdates.artifacts = JSON.stringify(newArtifacts);
      if (params.artifacts.length > 0) {
        changes.push(`artifacts added: ${params.artifacts.join(", ")}`);
      }
    }

    // Add notes (safe JSON parsing)
    if (params.notes) {
      const currentNotes = safeJsonParse<TaskNote[]>(taskData.notes, []);
      currentNotes.push({
        agentId: params.agentId,
        note: params.notes,
        timestamp: now,
      });
      hashUpdates.notes = JSON.stringify(currentNotes);
      changes.push(`note added`);
    }

    // Update priority
    if (params.priority && params.priority !== taskData.priority) {
      hashUpdates.priority = params.priority;
      changes.push(`priority: ${taskData.priority} → ${params.priority}`);
    }

    // Perform atomic update with optimistic locking
    const updateResult = await this.redis.atomicHashUpdate(
      KEYS.TASK(params.taskId),
      hashUpdates,
      expectedVersion
    );

    if (updateResult === null) {
      throw new Error(
        `Task ${params.taskId} was modified by another agent. Please retry the operation.`
      );
    }

    // Update indexes (these are idempotent, so safe even without transaction)
    if (params.status && params.status !== oldStatus) {
      await this.redis.srem(KEYS.BY_STATUS(oldStatus), params.taskId);
      await this.redis.sadd(KEYS.BY_STATUS(params.status), params.taskId);
    }

    if (params.assignee !== undefined && params.assignee !== oldAssignee) {
      if (oldAssignee) {
        await this.redis.srem(KEYS.BY_AGENT(oldAssignee), params.taskId);
      }
      if (params.assignee) {
        await this.redis.sadd(KEYS.BY_AGENT(params.assignee), params.taskId);
      }
    }

    // Record event
    if (changes.length > 0) {
      await this.addEvent(params.taskId, params.agentId, "updated", changes.join("; "));
    }

    // Get updated task
    const task = await this.get({ taskId: params.taskId });

    // Publish update event
    await this.redis.publish("events:task", JSON.stringify({
      type: "task_updated",
      task: task,
      changes: changes,
      updatedBy: params.agentId,
      timestamp: now,
    }));

    // Notify relevant agents
    if (taskData.reporter && taskData.reporter !== params.agentId) {
      notifiedAgents.push(taskData.reporter);
    }
    if (oldAssignee && oldAssignee !== params.agentId && oldAssignee !== params.assignee) {
      notifiedAgents.push(oldAssignee);
    }

    // Filter out empty agent IDs and duplicates
    const uniqueAgents = [...new Set(notifiedAgents.filter(id => id))];

    for (const agentId of uniqueAgents) {
      await this.redis.publish(`notify:${agentId}`, JSON.stringify({
        type: "task_updated",
        task: task,
        changes: changes,
      }));
    }

    return {
      success: true,
      task: task!,
      notifiedAgents: uniqueAgents,
    };
  }

  /**
   * Get a task by ID
   */
  async get(params: { taskId: string }): Promise<Task | null> {
    const taskData = await this.redis.hgetall(KEYS.TASK(params.taskId));

    if (!taskData.id) {
      return null;
    }

    return {
      id: taskData.id,
      title: taskData.title,
      description: taskData.description,
      status: taskData.status as TaskStatus,
      priority: taskData.priority as Priority,
      assignee: taskData.assignee || undefined,
      reporter: taskData.reporter,
      dependencies: safeJsonParse<string[]>(taskData.dependencies, []),
      blockedBy: safeJsonParse<string[]>(taskData.blockedBy, []),
      artifacts: safeJsonParse<string[]>(taskData.artifacts, []),
      notes: safeJsonParse<TaskNote[]>(taskData.notes, []),
      createdAt: parseInt(taskData.createdAt) || 0,
      updatedAt: parseInt(taskData.updatedAt) || 0,
      completedAt: taskData.completedAt ? parseInt(taskData.completedAt) : undefined,
    };
  }

  /**
   * List tasks with filters
   */
  async list(params?: {
    status?: TaskStatus;
    assignee?: string;
    reporter?: string;
    priority?: Priority;
    limit?: number;
  }): Promise<{ tasks: Task[]; totalCount: number }> {
    let taskIds: string[];

    // Get task IDs based on filter
    if (params?.status) {
      taskIds = await this.redis.smembers(KEYS.BY_STATUS(params.status));
    } else if (params?.assignee) {
      taskIds = await this.redis.smembers(KEYS.BY_AGENT(params.assignee));
    } else if (params?.reporter) {
      taskIds = await this.redis.smembers(KEYS.BY_REPORTER(params.reporter));
    } else {
      taskIds = await this.redis.smembers(KEYS.ALL_TASKS);
    }

    const tasks: Task[] = [];
    for (const taskId of taskIds) {
      const task = await this.get({ taskId });
      if (!task) continue;

      // Apply additional filters
      if (params?.status && task.status !== params.status) continue;
      if (params?.assignee && task.assignee !== params.assignee) continue;
      if (params?.reporter && task.reporter !== params.reporter) continue;
      if (params?.priority && task.priority !== params.priority) continue;

      tasks.push(task);
    }

    // Sort by priority and creation date
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    tasks.sort((a, b) => {
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      return b.createdAt - a.createdAt;
    });

    // Apply limit
    const limit = params?.limit || 50;
    return {
      tasks: tasks.slice(0, limit),
      totalCount: tasks.length,
    };
  }

  /**
   * Get task history/events
   */
  async getHistory(params: { taskId: string }): Promise<{ events: TaskEvent[] }> {
    const rawEvents = await this.redis.lrange(KEYS.TASK_EVENTS(params.taskId), 0, -1);
    
    const events: TaskEvent[] = [];
    for (const raw of rawEvents) {
      try {
        events.push(JSON.parse(raw) as TaskEvent);
      } catch {
        // Skip invalid
      }
    }

    return { events };
  }

  /**
   * Delete a task
   */
  async delete(params: { taskId: string; agentId: string }): Promise<{ success: boolean }> {
    const task = await this.get({ taskId: params.taskId });
    if (!task) {
      return { success: false };
    }

    // Remove from all indexes
    await this.redis.srem(KEYS.ALL_TASKS, params.taskId);
    await this.redis.srem(KEYS.BY_STATUS(task.status), params.taskId);
    await this.redis.srem(KEYS.BY_REPORTER(task.reporter), params.taskId);
    
    if (task.assignee) {
      await this.redis.srem(KEYS.BY_AGENT(task.assignee), params.taskId);
    }

    // Delete task data and events
    await this.redis.del(KEYS.TASK(params.taskId));
    await this.redis.del(KEYS.TASK_EVENTS(params.taskId));

    // Publish delete event
    await this.redis.publish("events:task", JSON.stringify({
      type: "task_deleted",
      taskId: params.taskId,
      deletedBy: params.agentId,
      timestamp: Date.now(),
    }));

    return { success: true };
  }

  /**
   * Add event to task history
   */
  private async addEvent(
    taskId: string,
    agentId: string,
    action: string,
    details: string
  ): Promise<void> {
    const event: TaskEvent = {
      taskId,
      agentId,
      action,
      details,
      timestamp: Date.now(),
    };

    await this.redis.lpush(KEYS.TASK_EVENTS(taskId), JSON.stringify(event));
  }
}
