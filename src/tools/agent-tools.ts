import { v4 as uuidv4 } from "uuid";
import { RedisClient } from "../redis-client.js";
import type { AgentInfo, AgentStatus, TeamStatus, Task } from "../types.js";

const KEYS = {
  REGISTRY: "agents:registry",
  PRESENCE: (id: string) => `agents:presence:${id}`,
  CHANNELS: (id: string) => `agents:channels:${id}`,
};

export class AgentTools {
  constructor(private redis: RedisClient, private heartbeatTTL: number) {}

  /**
   * Register a new agent with the team
   */
  async register(params: {
    agentId: string;
    role: string;
    name: string;
    capabilities?: string[];
  }): Promise<{ success: boolean; agent: AgentInfo; teamSize: number }> {
    const now = Date.now();
    
    const agent: AgentInfo = {
      id: params.agentId,
      role: params.role,
      name: params.name,
      capabilities: params.capabilities || [],
      status: "active",
      lastSeen: now,
      registeredAt: now,
    };

    // Store in registry hash
    await this.redis.hsetJson(KEYS.REGISTRY, params.agentId, agent);
    
    // Set presence with TTL
    await this.redis.set(KEYS.PRESENCE(params.agentId), String(now), this.heartbeatTTL);

    // Get team size
    const agents = await this.redis.hkeys(KEYS.REGISTRY);

    // Publish join event
    await this.redis.publish("events:agent", JSON.stringify({
      type: "agent_joined",
      agent: agent,
      timestamp: now,
    }));

    return {
      success: true,
      agent,
      teamSize: agents.length,
    };
  }

  /**
   * Send heartbeat to maintain agent presence
   */
  async heartbeat(params: {
    agentId: string;
    status?: AgentStatus;
    currentTask?: string;
  }): Promise<{ success: boolean; ttl: number }> {
    const now = Date.now();
    
    // Update presence TTL
    await this.redis.set(KEYS.PRESENCE(params.agentId), String(now), this.heartbeatTTL);

    // Update agent info if status changed
    const agent = await this.redis.hgetJson<AgentInfo>(KEYS.REGISTRY, params.agentId);
    if (agent) {
      agent.lastSeen = now;
      if (params.status) agent.status = params.status;
      if (params.currentTask !== undefined) agent.currentTask = params.currentTask;
      await this.redis.hsetJson(KEYS.REGISTRY, params.agentId, agent);
    }

    return {
      success: true,
      ttl: this.heartbeatTTL,
    };
  }

  /**
   * Deregister an agent from the team
   */
  async deregister(params: { agentId: string }): Promise<{ success: boolean }> {
    const agent = await this.redis.hgetJson<AgentInfo>(KEYS.REGISTRY, params.agentId);
    
    // Remove from registry
    await this.redis.hdel(KEYS.REGISTRY, params.agentId);
    
    // Remove presence
    await this.redis.del(KEYS.PRESENCE(params.agentId));
    
    // Remove channel subscriptions
    await this.redis.del(KEYS.CHANNELS(params.agentId));

    // Publish leave event
    if (agent) {
      await this.redis.publish("events:agent", JSON.stringify({
        type: "agent_left",
        agent: agent,
        timestamp: Date.now(),
      }));
    }

    return { success: true };
  }

  /**
   * Get status of all team members
   */
  async getTeamStatus(): Promise<TeamStatus> {
    const registry = await this.redis.hgetall(KEYS.REGISTRY);
    const agents: AgentInfo[] = [];
    
    let activeCount = 0;
    let busyCount = 0;
    let idleCount = 0;
    let offlineCount = 0;

    for (const [agentId, data] of Object.entries(registry)) {
      try {
        const agent = JSON.parse(data) as AgentInfo;
        
        // Check if agent is still alive (has presence)
        const isAlive = await this.redis.exists(KEYS.PRESENCE(agentId));
        if (!isAlive) {
          agent.status = "offline";
        }

        agents.push(agent);

        switch (agent.status) {
          case "active": activeCount++; break;
          case "busy": busyCount++; break;
          case "idle": idleCount++; break;
          case "offline": offlineCount++; break;
        }
      } catch {
        // Skip invalid entries
      }
    }

    // Get task summary
    const taskStatuses = ["pending", "in-progress", "review", "blocked", "completed"];
    const tasksSummary = {
      pending: 0,
      inProgress: 0,
      review: 0,
      blocked: 0,
      completed: 0,
    };

    for (const status of taskStatuses) {
      const count = await this.redis.scard(`tasks:by-status:${status}`);
      switch (status) {
        case "pending": tasksSummary.pending = count; break;
        case "in-progress": tasksSummary.inProgress = count; break;
        case "review": tasksSummary.review = count; break;
        case "blocked": tasksSummary.blocked = count; break;
        case "completed": tasksSummary.completed = count; break;
      }
    }

    return {
      agents,
      activeCount,
      busyCount,
      idleCount,
      offlineCount,
      tasksSummary,
    };
  }

  /**
   * Get detailed status of a specific agent
   */
  async getAgentStatus(params: { agentId: string }): Promise<{
    agent: AgentInfo | null;
    currentTasks: Task[];
    unreadMessages: number;
    isOnline: boolean;
  }> {
    const agent = await this.redis.hgetJson<AgentInfo>(KEYS.REGISTRY, params.agentId);
    const isOnline = await this.redis.exists(KEYS.PRESENCE(params.agentId));
    
    // Get current tasks
    const taskIds = await this.redis.smembers(`tasks:by-agent:${params.agentId}`);
    const currentTasks: Task[] = [];
    
    for (const taskId of taskIds) {
      const taskData = await this.redis.hgetall(`tasks:${taskId}`);
      if (taskData && taskData.id) {
        currentTasks.push({
          id: taskData.id,
          title: taskData.title,
          description: taskData.description,
          status: taskData.status as Task["status"],
          priority: taskData.priority as Task["priority"],
          assignee: taskData.assignee,
          reporter: taskData.reporter,
          dependencies: JSON.parse(taskData.dependencies || "[]"),
          blockedBy: JSON.parse(taskData.blockedBy || "[]"),
          artifacts: JSON.parse(taskData.artifacts || "[]"),
          notes: JSON.parse(taskData.notes || "[]"),
          createdAt: parseInt(taskData.createdAt),
          updatedAt: parseInt(taskData.updatedAt),
          completedAt: taskData.completedAt ? parseInt(taskData.completedAt) : undefined,
        });
      }
    }

    // Get unread message count
    const unreadMessages = await this.redis.llen(`messages:inbox:${params.agentId}`);

    return {
      agent: agent ? { ...agent, status: isOnline ? agent.status : "offline" } : null,
      currentTasks,
      unreadMessages,
      isOnline,
    };
  }

  /**
   * List all registered agents
   */
  async listAgents(params?: { role?: string; status?: AgentStatus }): Promise<AgentInfo[]> {
    const registry = await this.redis.hgetall(KEYS.REGISTRY);
    const agents: AgentInfo[] = [];

    for (const [agentId, data] of Object.entries(registry)) {
      try {
        const agent = JSON.parse(data) as AgentInfo;
        
        // Check presence
        const isAlive = await this.redis.exists(KEYS.PRESENCE(agentId));
        if (!isAlive) {
          agent.status = "offline";
        }

        // Apply filters
        if (params?.role && agent.role !== params.role) continue;
        if (params?.status && agent.status !== params.status) continue;

        agents.push(agent);
      } catch {
        // Skip invalid entries
      }
    }

    return agents;
  }
}
