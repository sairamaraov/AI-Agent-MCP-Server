import { v4 as uuidv4 } from "uuid";
import { RedisClient } from "./redis-client.js";
import type {
  AgentInfo,
  AgentStatus,
  Message,
  MessageType,
  Priority,
  ChannelMessage,
  ChannelInfo,
  Task,
  TaskStatus,
  TaskEvent,
  Artifact,
  ArtifactType,
  TeamStatus,
  Config,
} from "./types.js";

// Redis key constants
const KEYS = {
  AGENTS_REGISTRY: "agents:registry",
  AGENTS_PRESENCE: (id: string) => `agents:presence:${id}`,
  MESSAGES_INBOX: (id: string) => `messages:inbox:${id}`,
  CHANNELS_MESSAGES: (ch: string) => `channels:${ch}:messages`,
  CHANNELS_SUBSCRIBERS: (ch: string) => `channels:${ch}:subscribers`,
  CHANNELS_INFO: (ch: string) => `channels:${ch}:info`,
  TASKS: (id: string) => `tasks:${id}`,
  TASKS_BY_STATUS: (status: string) => `tasks:by-status:${status}`,
  TASKS_BY_AGENT: (id: string) => `tasks:by-agent:${id}`,
  TASKS_ALL: "tasks:all",
  TASKS_HISTORY: (id: string) => `tasks:${id}:history`,
  ARTIFACTS: (id: string) => `artifacts:${id}`,
  ARTIFACTS_ALL: "artifacts:all",
  PUBSUB_BROADCAST: "broadcast:all",
  PUBSUB_ROLE: (role: string) => `broadcast:role:${role}`,
  PUBSUB_AGENT: (id: string) => `notify:agent:${id}`,
  PUBSUB_CHANNEL: (ch: string) => `channel:${ch}`,
};

export class AgentHandlers {
  private redis: RedisClient;
  private config: Config["agent"];

  constructor(redis: RedisClient, config: Config["agent"]) {
    this.redis = redis;
    this.config = config;
  }

  // ============ AGENT MANAGEMENT ============

  async agentRegister(params: {
    agentId: string;
    role: string;
    name: string;
    capabilities: string[];
  }): Promise<{ success: boolean; agent: AgentInfo; teamSize: number }> {
    const now = Date.now();
    const agent: AgentInfo = {
      id: params.agentId,
      role: params.role,
      name: params.name,
      capabilities: params.capabilities,
      status: "active",
      lastSeen: now,
      registeredAt: now,
    };

    // Register in agents hash
    await this.redis.hsetJson(KEYS.AGENTS_REGISTRY, params.agentId, agent);

    // Set presence with TTL
    await this.redis.set(
      KEYS.AGENTS_PRESENCE(params.agentId),
      String(now),
      this.config.heartbeatTTL
    );

    // Get team size
    const agents = await this.redis.hkeys(KEYS.AGENTS_REGISTRY);
    const teamSize = agents.length;

    // Broadcast join notification
    await this.redis.publish(
      KEYS.PUBSUB_BROADCAST,
      JSON.stringify({
        type: "agent_joined",
        agent: agent,
        timestamp: now,
      })
    );

    return { success: true, agent, teamSize };
  }

  async agentHeartbeat(params: {
    agentId: string;
    status: AgentStatus;
    currentTask?: string;
  }): Promise<{ success: boolean; ttl: number }> {
    const now = Date.now();

    // Update presence TTL
    await this.redis.set(
      KEYS.AGENTS_PRESENCE(params.agentId),
      String(now),
      this.config.heartbeatTTL
    );

    // Update agent info
    const agent = await this.redis.hgetJson<AgentInfo>(
      KEYS.AGENTS_REGISTRY,
      params.agentId
    );
    if (agent) {
      agent.status = params.status;
      agent.lastSeen = now;
      if (params.currentTask !== undefined) {
        agent.currentTask = params.currentTask;
      }
      await this.redis.hsetJson(KEYS.AGENTS_REGISTRY, params.agentId, agent);
    }

    return { success: true, ttl: this.config.heartbeatTTL };
  }

  async agentDeregister(params: {
    agentId: string;
  }): Promise<{ success: boolean }> {
    const agent = await this.redis.hgetJson<AgentInfo>(
      KEYS.AGENTS_REGISTRY,
      params.agentId
    );

    // Remove from registry
    await this.redis.hdel(KEYS.AGENTS_REGISTRY, params.agentId);

    // Remove presence
    await this.redis.del(KEYS.AGENTS_PRESENCE(params.agentId));

    // Broadcast leave notification
    if (agent) {
      await this.redis.publish(
        KEYS.PUBSUB_BROADCAST,
        JSON.stringify({
          type: "agent_left",
          agent: agent,
          timestamp: Date.now(),
        })
      );
    }

    return { success: true };
  }

  async agentStatus(params: {
    agentId: string;
  }): Promise<{
    agent: AgentInfo | null;
    currentTasks: Task[];
    unreadMessages: number;
    isOnline: boolean;
  }> {
    const agent = await this.redis.hgetJson<AgentInfo>(
      KEYS.AGENTS_REGISTRY,
      params.agentId
    );

    const isOnline = await this.redis.exists(KEYS.AGENTS_PRESENCE(params.agentId));

    // Get tasks assigned to agent
    const taskIds = await this.redis.smembers(KEYS.TASKS_BY_AGENT(params.agentId));
    const currentTasks: Task[] = [];
    for (const taskId of taskIds) {
      const task = await this.redis.getJson<Task>(KEYS.TASKS(taskId));
      if (task && task.status !== "completed" && task.status !== "cancelled") {
        currentTasks.push(task);
      }
    }

    // Get unread message count
    const unreadMessages = await this.redis.llen(KEYS.MESSAGES_INBOX(params.agentId));

    return { agent, currentTasks, unreadMessages, isOnline };
  }

  // ============ MESSAGING ============

  async sendMessage(params: {
    from: string;
    to: string;
    subject: string;
    content: string;
    type: MessageType;
    priority: Priority;
    replyTo?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ messageId: string; delivered: boolean; timestamp: number }> {
    const now = Date.now();
    const messageId = uuidv4();

    const message: Message = {
      id: messageId,
      from: params.from,
      to: params.to,
      type: params.type,
      subject: params.subject,
      content: params.content,
      priority: params.priority,
      timestamp: now,
      replyTo: params.replyTo,
      metadata: params.metadata,
      read: false,
    };

    // Push to recipient's inbox
    await this.redis.lpush(
      KEYS.MESSAGES_INBOX(params.to),
      JSON.stringify(message)
    );

    // Trim inbox to max history
    await this.redis.ltrim(
      KEYS.MESSAGES_INBOX(params.to),
      0,
      this.config.maxMessageHistory - 1
    );

    // Publish notification to recipient
    await this.redis.publish(
      KEYS.PUBSUB_AGENT(params.to),
      JSON.stringify({
        type: "new_message",
        messageId,
        from: params.from,
        subject: params.subject,
        priority: params.priority,
        timestamp: now,
      })
    );

    return { messageId, delivered: true, timestamp: now };
  }

  async getMessages(params: {
    agentId: string;
    limit?: number;
    since?: number;
    markAsRead?: boolean;
  }): Promise<{ messages: Message[]; unreadCount: number }> {
    const limit = params.limit || 20;
    const messageStrings = await this.redis.lrange(
      KEYS.MESSAGES_INBOX(params.agentId),
      0,
      limit - 1
    );

    let messages: Message[] = messageStrings
      .map((str) => {
        try {
          return JSON.parse(str) as Message;
        } catch {
          return null;
        }
      })
      .filter((m): m is Message => m !== null);

    // Filter by timestamp if since provided
    if (params.since) {
      messages = messages.filter((m) => m.timestamp > params.since!);
    }

    const unreadCount = messages.filter((m) => !m.read).length;

    return { messages, unreadCount };
  }

  async broadcastMessage(params: {
    from: string;
    content: string;
    subject: string;
    targetRole?: string;
    priority: Priority;
  }): Promise<{ messageId: string; recipientCount: number }> {
    const now = Date.now();
    const messageId = uuidv4();

    // Get all agents (or filtered by role)
    const allAgents = await this.redis.hgetall(KEYS.AGENTS_REGISTRY);
    let recipients: AgentInfo[] = [];

    for (const [, agentJson] of Object.entries(allAgents)) {
      try {
        const agent = JSON.parse(agentJson) as AgentInfo;
        if (!params.targetRole || agent.role === params.targetRole) {
          recipients.push(agent);
        }
      } catch {
        // Skip invalid entries
      }
    }

    // Send to each recipient
    for (const recipient of recipients) {
      if (recipient.id !== params.from) {
        const message: Message = {
          id: messageId,
          from: params.from,
          to: recipient.id,
          type: "notification",
          subject: params.subject,
          content: params.content,
          priority: params.priority,
          timestamp: now,
          metadata: { broadcast: true, targetRole: params.targetRole },
          read: false,
        };

        await this.redis.lpush(
          KEYS.MESSAGES_INBOX(recipient.id),
          JSON.stringify(message)
        );
      }
    }

    // Publish to broadcast channel
    const channel = params.targetRole
      ? KEYS.PUBSUB_ROLE(params.targetRole)
      : KEYS.PUBSUB_BROADCAST;

    await this.redis.publish(
      channel,
      JSON.stringify({
        type: "broadcast",
        messageId,
        from: params.from,
        subject: params.subject,
        content: params.content,
        priority: params.priority,
        targetRole: params.targetRole,
        timestamp: now,
      })
    );

    return { messageId, recipientCount: recipients.length - 1 };
  }

  // ============ CHANNEL COMMUNICATION ============

  async channelSubscribe(params: {
    agentId: string;
    channel: string;
  }): Promise<{ success: boolean; channelInfo: ChannelInfo }> {
    // Add agent to channel subscribers
    await this.redis.sadd(KEYS.CHANNELS_SUBSCRIBERS(params.channel), params.agentId);

    // Get channel info
    const subscriberCount = await this.redis.scard(
      KEYS.CHANNELS_SUBSCRIBERS(params.channel)
    );
    const messageCount = await this.redis.llen(
      KEYS.CHANNELS_MESSAGES(params.channel)
    );

    const channelInfo: ChannelInfo = {
      name: params.channel,
      subscriberCount,
      messageCount,
      lastActivity: Date.now(),
    };

    // Store channel info
    await this.redis.setJson(KEYS.CHANNELS_INFO(params.channel), channelInfo);

    return { success: true, channelInfo };
  }

  async channelUnsubscribe(params: {
    agentId: string;
    channel: string;
  }): Promise<{ success: boolean }> {
    await this.redis.srem(KEYS.CHANNELS_SUBSCRIBERS(params.channel), params.agentId);
    return { success: true };
  }

  async channelPublish(params: {
    agentId: string;
    channel: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ messageId: string; subscriberCount: number }> {
    const now = Date.now();
    const messageId = uuidv4();

    const message: ChannelMessage = {
      id: messageId,
      from: params.agentId,
      channel: params.channel,
      content: params.content,
      timestamp: now,
      metadata: params.metadata,
    };

    // Add to channel history
    await this.redis.lpush(
      KEYS.CHANNELS_MESSAGES(params.channel),
      JSON.stringify(message)
    );

    // Trim history
    await this.redis.ltrim(
      KEYS.CHANNELS_MESSAGES(params.channel),
      0,
      this.config.maxChannelHistory - 1
    );

    // Publish to pub/sub
    await this.redis.publish(
      KEYS.PUBSUB_CHANNEL(params.channel),
      JSON.stringify(message)
    );

    const subscriberCount = await this.redis.scard(
      KEYS.CHANNELS_SUBSCRIBERS(params.channel)
    );

    return { messageId, subscriberCount };
  }

  async channelHistory(params: {
    channel: string;
    limit?: number;
    since?: number;
  }): Promise<{ messages: ChannelMessage[] }> {
    const limit = params.limit || 50;
    const messageStrings = await this.redis.lrange(
      KEYS.CHANNELS_MESSAGES(params.channel),
      0,
      limit - 1
    );

    let messages: ChannelMessage[] = messageStrings
      .map((str) => {
        try {
          return JSON.parse(str) as ChannelMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is ChannelMessage => m !== null);

    if (params.since) {
      messages = messages.filter((m) => m.timestamp > params.since!);
    }

    return { messages };
  }

  async channelList(): Promise<{ channels: ChannelInfo[] }> {
    // Get all channel keys (this is a simplified approach)
    // In production, you'd want to maintain a separate set of channel names
    const channels: ChannelInfo[] = [];

    // For now, return channels that have subscribers
    // This would need to be enhanced to track all channels
    return { channels };
  }

  // ============ TASK MANAGEMENT ============

  async taskCreate(params: {
    title: string;
    description: string;
    priority: Priority;
    assignee?: string;
    dependencies?: string[];
    reporter: string;
  }): Promise<{ taskId: string; task: Task }> {
    const now = Date.now();
    const taskId = uuidv4();

    const task: Task = {
      id: taskId,
      title: params.title,
      description: params.description,
      status: params.assignee ? "assigned" : "pending",
      priority: params.priority,
      assignee: params.assignee,
      reporter: params.reporter,
      dependencies: params.dependencies || [],
      blockedBy: [],
      artifacts: [],
      notes: [],
      createdAt: now,
      updatedAt: now,
    };

    // Store task
    await this.redis.setJson(KEYS.TASKS(taskId), task);

    // Add to all tasks set
    await this.redis.sadd(KEYS.TASKS_ALL, taskId);

    // Add to status set
    await this.redis.sadd(KEYS.TASKS_BY_STATUS(task.status), taskId);

    // Add to assignee's task set
    if (params.assignee) {
      await this.redis.sadd(KEYS.TASKS_BY_AGENT(params.assignee), taskId);

      // Notify assignee
      await this.sendMessage({
        from: params.reporter,
        to: params.assignee,
        subject: `New Task Assigned: ${params.title}`,
        content: `You have been assigned a new task.\n\nTitle: ${params.title}\nPriority: ${params.priority}\nDescription: ${params.description}`,
        type: "notification",
        priority: params.priority,
        metadata: { taskId },
      });
    }

    // Record history
    await this.addTaskEvent(taskId, params.reporter, "created", "Task created");

    return { taskId, task };
  }

  async taskUpdate(params: {
    taskId: string;
    agentId: string;
    status?: TaskStatus;
    assignee?: string;
    blockedBy?: string[];
    artifacts?: string[];
    notes?: string;
  }): Promise<{ success: boolean; task: Task | null; notifiedAgents: string[] }> {
    const task = await this.redis.getJson<Task>(KEYS.TASKS(params.taskId));
    if (!task) {
      return { success: false, task: null, notifiedAgents: [] };
    }

    const oldStatus = task.status;
    const oldAssignee = task.assignee;
    const notifiedAgents: string[] = [];

    // Update status
    if (params.status && params.status !== oldStatus) {
      // Remove from old status set
      await this.redis.srem(KEYS.TASKS_BY_STATUS(oldStatus), params.taskId);
      // Add to new status set
      await this.redis.sadd(KEYS.TASKS_BY_STATUS(params.status), params.taskId);

      task.status = params.status;
      await this.addTaskEvent(
        params.taskId,
        params.agentId,
        "status_changed",
        `Status changed from ${oldStatus} to ${params.status}`
      );

      if (params.status === "completed") {
        task.completedAt = Date.now();
      }
    }

    // Update assignee
    if (params.assignee !== undefined && params.assignee !== oldAssignee) {
      if (oldAssignee) {
        await this.redis.srem(KEYS.TASKS_BY_AGENT(oldAssignee), params.taskId);
      }
      if (params.assignee) {
        await this.redis.sadd(KEYS.TASKS_BY_AGENT(params.assignee), params.taskId);
        notifiedAgents.push(params.assignee);

        // Notify new assignee
        await this.sendMessage({
          from: params.agentId,
          to: params.assignee,
          subject: `Task Assigned: ${task.title}`,
          content: `Task "${task.title}" has been assigned to you.`,
          type: "notification",
          priority: task.priority,
          metadata: { taskId: params.taskId },
        });
      }
      task.assignee = params.assignee;
    }

    // Update blocked by
    if (params.blockedBy !== undefined) {
      task.blockedBy = params.blockedBy;
      if (params.blockedBy.length > 0) {
        task.status = "blocked";
        await this.redis.srem(KEYS.TASKS_BY_STATUS(oldStatus), params.taskId);
        await this.redis.sadd(KEYS.TASKS_BY_STATUS("blocked"), params.taskId);
      }
    }

    // Update artifacts
    if (params.artifacts) {
      task.artifacts = [...task.artifacts, ...params.artifacts];
    }

    // Add notes
    if (params.notes) {
      task.notes.push({
        agentId: params.agentId,
        note: params.notes,
        timestamp: Date.now(),
      });
      await this.addTaskEvent(params.taskId, params.agentId, "note_added", params.notes);
    }

    task.updatedAt = Date.now();

    // Save task
    await this.redis.setJson(KEYS.TASKS(params.taskId), task);

    // Notify reporter of status changes
    if (params.status && task.reporter !== params.agentId) {
      notifiedAgents.push(task.reporter);
      await this.sendMessage({
        from: params.agentId,
        to: task.reporter,
        subject: `Task Update: ${task.title}`,
        content: `Task "${task.title}" status changed to ${params.status}.${params.notes ? `\n\nNote: ${params.notes}` : ""}`,
        type: "notification",
        priority: "normal",
        metadata: { taskId: params.taskId },
      });
    }

    return { success: true, task, notifiedAgents };
  }

  async taskList(params: {
    status?: TaskStatus;
    assignee?: string;
    priority?: Priority;
    limit?: number;
  }): Promise<{ tasks: Task[]; totalCount: number }> {
    let taskIds: string[];

    if (params.assignee) {
      taskIds = await this.redis.smembers(KEYS.TASKS_BY_AGENT(params.assignee));
    } else if (params.status) {
      taskIds = await this.redis.smembers(KEYS.TASKS_BY_STATUS(params.status));
    } else {
      taskIds = await this.redis.smembers(KEYS.TASKS_ALL);
    }

    const tasks: Task[] = [];
    for (const taskId of taskIds) {
      const task = await this.redis.getJson<Task>(KEYS.TASKS(taskId));
      if (task) {
        // Apply filters
        if (params.status && task.status !== params.status) continue;
        if (params.assignee && task.assignee !== params.assignee) continue;
        if (params.priority && task.priority !== params.priority) continue;

        tasks.push(task);
      }
    }

    // Sort by priority and creation date
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    tasks.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.createdAt - a.createdAt;
    });

    const totalCount = tasks.length;
    const limitedTasks = params.limit ? tasks.slice(0, params.limit) : tasks;

    return { tasks: limitedTasks, totalCount };
  }

  async taskGet(params: {
    taskId: string;
  }): Promise<{ task: Task | null; history: TaskEvent[] }> {
    const task = await this.redis.getJson<Task>(KEYS.TASKS(params.taskId));

    const historyStrings = await this.redis.lrange(
      KEYS.TASKS_HISTORY(params.taskId),
      0,
      -1
    );
    const history: TaskEvent[] = historyStrings
      .map((str) => {
        try {
          return JSON.parse(str) as TaskEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is TaskEvent => e !== null);

    return { task, history };
  }

  private async addTaskEvent(
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

    await this.redis.lpush(KEYS.TASKS_HISTORY(taskId), JSON.stringify(event));
    await this.redis.ltrim(KEYS.TASKS_HISTORY(taskId), 0, 99); // Keep last 100 events
  }

  // ============ TEAM STATUS ============

  async teamStatus(): Promise<TeamStatus> {
    const allAgentsData = await this.redis.hgetall(KEYS.AGENTS_REGISTRY);
    const agents: AgentInfo[] = [];

    for (const [agentId, agentJson] of Object.entries(allAgentsData)) {
      try {
        const agent = JSON.parse(agentJson) as AgentInfo;

        // Check if agent is online (has valid presence)
        const isOnline = await this.redis.exists(KEYS.AGENTS_PRESENCE(agentId));
        if (!isOnline) {
          agent.status = "offline";
        }

        agents.push(agent);
      } catch {
        // Skip invalid entries
      }
    }

    const activeCount = agents.filter((a) => a.status === "active").length;
    const busyCount = agents.filter((a) => a.status === "busy").length;
    const idleCount = agents.filter((a) => a.status === "idle").length;
    const offlineCount = agents.filter((a) => a.status === "offline").length;

    // Get task summary
    const pending = await this.redis.scard(KEYS.TASKS_BY_STATUS("pending"));
    const assigned = await this.redis.scard(KEYS.TASKS_BY_STATUS("assigned"));
    const inProgress = await this.redis.scard(KEYS.TASKS_BY_STATUS("in-progress"));
    const review = await this.redis.scard(KEYS.TASKS_BY_STATUS("review"));
    const blocked = await this.redis.scard(KEYS.TASKS_BY_STATUS("blocked"));
    const completed = await this.redis.scard(KEYS.TASKS_BY_STATUS("completed"));

    return {
      agents,
      activeCount,
      busyCount,
      idleCount,
      offlineCount,
      tasksSummary: {
        pending: pending + assigned,
        inProgress,
        review,
        blocked,
        completed,
      },
    };
  }

  // ============ ARTIFACT MANAGEMENT ============

  async artifactRegister(params: {
    path: string;
    type: ArtifactType;
    owner: string;
    description: string;
    version?: string;
  }): Promise<{ artifactId: string; artifact: Artifact }> {
    const now = Date.now();
    const artifactId = uuidv4();

    const artifact: Artifact = {
      id: artifactId,
      path: params.path,
      type: params.type,
      owner: params.owner,
      description: params.description,
      version: params.version || "1.0.0",
      createdAt: now,
      updatedAt: now,
    };

    await this.redis.setJson(KEYS.ARTIFACTS(artifactId), artifact);
    await this.redis.sadd(KEYS.ARTIFACTS_ALL, artifactId);

    return { artifactId, artifact };
  }

  async artifactList(params: {
    type?: ArtifactType;
    owner?: string;
  }): Promise<{ artifacts: Artifact[] }> {
    const artifactIds = await this.redis.smembers(KEYS.ARTIFACTS_ALL);
    const artifacts: Artifact[] = [];

    for (const artifactId of artifactIds) {
      const artifact = await this.redis.getJson<Artifact>(KEYS.ARTIFACTS(artifactId));
      if (artifact) {
        if (params.type && artifact.type !== params.type) continue;
        if (params.owner && artifact.owner !== params.owner) continue;
        artifacts.push(artifact);
      }
    }

    return { artifacts };
  }

  async artifactNotify(params: {
    artifactId: string;
    changeType: "created" | "updated" | "deleted";
    changedBy: string;
    description: string;
    notifyAgents?: string[];
  }): Promise<{ notifiedCount: number }> {
    const artifact = await this.redis.getJson<Artifact>(KEYS.ARTIFACTS(params.artifactId));
    if (!artifact) {
      return { notifiedCount: 0 };
    }

    let recipients: string[];
    if (params.notifyAgents && params.notifyAgents.length > 0) {
      recipients = params.notifyAgents;
    } else {
      // Notify all agents
      const allAgents = await this.redis.hkeys(KEYS.AGENTS_REGISTRY);
      recipients = allAgents.filter((id) => id !== params.changedBy);
    }

    // Send notifications
    for (const agentId of recipients) {
      await this.sendMessage({
        from: params.changedBy,
        to: agentId,
        subject: `Artifact ${params.changeType}: ${artifact.path}`,
        content: `${params.description}\n\nPath: ${artifact.path}\nType: ${artifact.type}`,
        type: "notification",
        priority: "normal",
        metadata: { artifactId: params.artifactId, changeType: params.changeType },
      });
    }

    // Update artifact timestamp if updated
    if (params.changeType === "updated") {
      artifact.updatedAt = Date.now();
      await this.redis.setJson(KEYS.ARTIFACTS(params.artifactId), artifact);
    }

    return { notifiedCount: recipients.length };
  }

  async artifactGet(params: {
    artifactId: string;
  }): Promise<{ artifact: Artifact | null }> {
    const artifact = await this.redis.getJson<Artifact>(KEYS.ARTIFACTS(params.artifactId));
    return { artifact };
  }
}
