#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { RedisClient } from "./redis-client.js";
import {
  AgentTools,
  MessageTools,
  ChannelTools,
  TaskTools,
  ArtifactTools,
} from "./tools/index.js";
import type { Config } from "./types.js";

// Configuration from environment or defaults
const config: Config = {
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || "0"),
    keyPrefix: process.env.REDIS_PREFIX || "agent-team:",
  },
  agent: {
    heartbeatInterval: 300000,
    heartbeatTTL: 300,
    maxMessageHistory: 100,
    maxChannelHistory: 1000,
  },
  server: {
    name: "redis-agent-mcp",
    version: "1.0.0",
  },
};

// Tool definitions for MCP
const TOOLS: Tool[] = [
  // ===== AGENT MANAGEMENT =====
  {
    name: "agent_register",
    description: "Register this agent with the team. Call this first when starting up to join the team and make yourself visible to other agents.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your unique agent ID (e.g., 'frontend-agent-1')" },
        role: { type: "string", description: "Your role (e.g., 'frontend-engineer', 'backend-engineer', 'tester')" },
        name: { type: "string", description: "Human-readable name for this agent" },
        capabilities: {
          type: "array",
          items: { type: "string" },
          description: "List of capabilities/skills (e.g., ['react', 'typescript', 'css'])",
        },
      },
      required: ["agentId", "role", "name"],
    },
  },
  {
    name: "agent_heartbeat",
    description: "Send a heartbeat to maintain your presence. Call this periodically (every 10-20 seconds) to show you're still active.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your agent ID" },
        status: {
          type: "string",
          enum: ["active", "busy", "idle"],
          description: "Your current status",
        },
        currentTask: { type: "string", description: "ID of task you're currently working on" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "agent_deregister",
    description: "Deregister from the team. Call this when shutting down gracefully.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your agent ID" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "team_status",
    description: "Get the status of all team members and overall task summary. Use this to see who's available and what the team is working on.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "agent_status",
    description: "Get detailed status of a specific agent including their current tasks and unread messages.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The agent ID to look up" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "list_agents",
    description: "List all registered agents, optionally filtered by role or status.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Filter by role" },
        status: {
          type: "string",
          enum: ["active", "busy", "idle", "offline"],
          description: "Filter by status",
        },
      },
    },
  },

  // ===== MESSAGING =====
  {
    name: "send_message",
    description: "Send a direct message to another agent. Use this to communicate specific requests, share information, or respond to other agents.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Your agent ID" },
        to: { type: "string", description: "Recipient agent ID" },
        subject: { type: "string", description: "Message subject/title" },
        content: { type: "string", description: "Message content" },
        type: {
          type: "string",
          enum: ["direct", "request", "response", "notification"],
          description: "Type of message",
        },
        priority: {
          type: "string",
          enum: ["critical", "high", "normal", "low"],
          description: "Message priority",
        },
        replyTo: { type: "string", description: "Message ID if this is a reply" },
        metadata: { type: "object", description: "Additional metadata" },
      },
      required: ["from", "to", "subject", "content"],
    },
  },
  {
    name: "get_messages",
    description: "Get your inbox or sent messages. Check this regularly for new messages from other agents.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your agent ID" },
        limit: { type: "number", description: "Max messages to retrieve (default 20)" },
        since: { type: "number", description: "Only get messages after this timestamp" },
        type: {
          type: "string",
          enum: ["inbox", "sent"],
          description: "Get inbox or sent messages",
        },
      },
      required: ["agentId"],
    },
  },
  {
    name: "broadcast_message",
    description: "Broadcast a message to all agents or all agents with a specific role. Use for announcements or team-wide updates.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Your agent ID" },
        subject: { type: "string", description: "Broadcast subject" },
        content: { type: "string", description: "Broadcast content" },
        targetRole: { type: "string", description: "Only send to agents with this role (optional)" },
        priority: {
          type: "string",
          enum: ["critical", "high", "normal", "low"],
          description: "Message priority",
        },
      },
      required: ["from", "subject", "content"],
    },
  },
  {
    name: "get_unread_count",
    description: "Get the count of unread messages in your inbox.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your agent ID" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "wait_for_messages",
    description: "Block and wait for new messages to arrive. Returns immediately when messages arrive, or after timeout. Much more efficient than polling get_messages repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your agent ID" },
        timeout: {
          type: "number",
          description: "Max seconds to wait (default 30, max 300). The call will return immediately if messages arrive before timeout."
        },
        includeMessages: {
          type: "boolean",
          description: "If true, fetch full message content along with notifications (default false)"
        },
      },
      required: ["agentId"],
    },
  },

  // ===== CHANNELS =====
  {
    name: "channel_subscribe",
    description: "Subscribe to a topic channel to receive messages about specific topics (e.g., 'api-updates', 'frontend', 'testing').",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your agent ID" },
        channel: { type: "string", description: "Channel name to subscribe to" },
      },
      required: ["agentId", "channel"],
    },
  },
  {
    name: "channel_unsubscribe",
    description: "Unsubscribe from a channel.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your agent ID" },
        channel: { type: "string", description: "Channel name to unsubscribe from" },
      },
      required: ["agentId", "channel"],
    },
  },
  {
    name: "channel_publish",
    description: "Publish a message to a channel for all subscribers to see.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Your agent ID" },
        channel: { type: "string", description: "Channel to publish to" },
        content: { type: "string", description: "Message content" },
        metadata: { type: "object", description: "Additional metadata" },
      },
      required: ["agentId", "channel", "content"],
    },
  },
  {
    name: "channel_history",
    description: "Get recent messages from a channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name" },
        limit: { type: "number", description: "Max messages to retrieve" },
        since: { type: "number", description: "Only get messages after this timestamp" },
      },
      required: ["channel"],
    },
  },
  {
    name: "list_channels",
    description: "List all available channels.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // ===== TASKS =====
  {
    name: "task_create",
    description: "Create a new task. Use this to assign work or track deliverables.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Detailed task description" },
        priority: {
          type: "string",
          enum: ["critical", "high", "normal", "low"],
          description: "Task priority",
        },
        assignee: { type: "string", description: "Agent ID to assign the task to" },
        reporter: { type: "string", description: "Your agent ID (who created this task)" },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Task IDs that must be completed first",
        },
      },
      required: ["title", "description", "reporter"],
    },
  },
  {
    name: "task_update",
    description: "Update a task's status, assignee, or add notes/artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to update" },
        agentId: { type: "string", description: "Your agent ID (who is making the update)" },
        status: {
          type: "string",
          enum: ["pending", "assigned", "in-progress", "review", "blocked", "completed", "cancelled"],
          description: "New task status",
        },
        assignee: { type: "string", description: "New assignee agent ID" },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description: "Task IDs blocking this task",
        },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "Paths to artifacts/deliverables",
        },
        notes: { type: "string", description: "Add a note to the task" },
        priority: {
          type: "string",
          enum: ["critical", "high", "normal", "low"],
          description: "Update priority",
        },
      },
      required: ["taskId", "agentId"],
    },
  },
  {
    name: "task_get",
    description: "Get detailed information about a specific task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to retrieve" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_list",
    description: "List tasks with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "assigned", "in-progress", "review", "blocked", "completed", "cancelled"],
          description: "Filter by status",
        },
        assignee: { type: "string", description: "Filter by assignee agent ID" },
        reporter: { type: "string", description: "Filter by reporter agent ID" },
        priority: {
          type: "string",
          enum: ["critical", "high", "normal", "low"],
          description: "Filter by priority",
        },
        limit: { type: "number", description: "Max tasks to return" },
      },
    },
  },
  {
    name: "task_history",
    description: "Get the history of events for a task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
      },
      required: ["taskId"],
    },
  },

  // ===== ARTIFACTS =====
  {
    name: "artifact_register",
    description: "Register a shared artifact (API spec, component, test, documentation) so other agents can find it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to the artifact" },
        type: {
          type: "string",
          enum: ["api-spec", "component", "test", "documentation", "config", "schema", "design"],
          description: "Type of artifact",
        },
        owner: { type: "string", description: "Your agent ID" },
        description: { type: "string", description: "Description of the artifact" },
        version: { type: "string", description: "Version string (e.g., '1.0.0')" },
      },
      required: ["path", "type", "owner", "description"],
    },
  },
  {
    name: "artifact_list",
    description: "List registered artifacts, optionally filtered by type or owner.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["api-spec", "component", "test", "documentation", "config", "schema", "design"],
          description: "Filter by artifact type",
        },
        owner: { type: "string", description: "Filter by owner agent ID" },
        limit: { type: "number", description: "Max artifacts to return" },
      },
    },
  },
  {
    name: "artifact_get",
    description: "Get details about a specific artifact.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "Artifact ID" },
      },
      required: ["artifactId"],
    },
  },
  {
    name: "artifact_notify",
    description: "Notify other agents about changes to an artifact.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "Artifact ID" },
        changeType: {
          type: "string",
          enum: ["created", "updated", "deleted"],
          description: "Type of change",
        },
        changedBy: { type: "string", description: "Your agent ID" },
        description: { type: "string", description: "Description of changes" },
        notifyAgents: {
          type: "array",
          items: { type: "string" },
          description: "Specific agents to notify (optional, broadcasts if not specified)",
        },
      },
      required: ["artifactId", "changeType", "changedBy", "description"],
    },
  },
  {
    name: "artifact_search",
    description: "Search for artifacts by path pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pathPattern: { type: "string", description: "Path pattern to search (supports * wildcard)" },
      },
      required: ["pathPattern"],
    },
  },
];

// Main server class
class RedisAgentMCPServer {
  private server: Server;
  private redis: RedisClient;
  private agentTools: AgentTools;
  private messageTools: MessageTools;
  private channelTools: ChannelTools;
  private taskTools: TaskTools;
  private artifactTools: ArtifactTools;
  private isShuttingDown = false;

  constructor() {
    this.server = new Server(
      {
        name: config.server.name,
        version: config.server.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.redis = new RedisClient(config.redis);
    this.agentTools = new AgentTools(this.redis, config.agent.heartbeatTTL);
    this.messageTools = new MessageTools(this.redis, config.agent.maxMessageHistory);
    this.channelTools = new ChannelTools(this.redis, config.agent.maxChannelHistory);
    this.taskTools = new TaskTools(this.redis);
    this.artifactTools = new ArtifactTools(this.redis);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.handleTool(name, args || {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: errorMessage }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      // Agent tools
      case "agent_register":
        return this.agentTools.register(args as Parameters<typeof this.agentTools.register>[0]);
      case "agent_heartbeat":
        return this.agentTools.heartbeat(args as Parameters<typeof this.agentTools.heartbeat>[0]);
      case "agent_deregister":
        return this.agentTools.deregister(args as Parameters<typeof this.agentTools.deregister>[0]);
      case "team_status":
        return this.agentTools.getTeamStatus();
      case "agent_status":
        return this.agentTools.getAgentStatus(args as Parameters<typeof this.agentTools.getAgentStatus>[0]);
      case "list_agents":
        return this.agentTools.listAgents(args as Parameters<typeof this.agentTools.listAgents>[0]);

      // Message tools
      case "send_message":
        return this.messageTools.sendMessage(args as Parameters<typeof this.messageTools.sendMessage>[0]);
      case "get_messages":
        return this.messageTools.getMessages(args as Parameters<typeof this.messageTools.getMessages>[0]);
      case "broadcast_message":
        return this.messageTools.broadcastMessage(args as Parameters<typeof this.messageTools.broadcastMessage>[0]);
      case "get_unread_count":
        return this.messageTools.getUnreadCount(args as Parameters<typeof this.messageTools.getUnreadCount>[0]);
      case "wait_for_messages":
        return this.messageTools.waitForMessages(args as Parameters<typeof this.messageTools.waitForMessages>[0]);

      // Channel tools
      case "channel_subscribe":
        return this.channelTools.subscribe(args as Parameters<typeof this.channelTools.subscribe>[0]);
      case "channel_unsubscribe":
        return this.channelTools.unsubscribe(args as Parameters<typeof this.channelTools.unsubscribe>[0]);
      case "channel_publish":
        return this.channelTools.publish(args as Parameters<typeof this.channelTools.publish>[0]);
      case "channel_history":
        return this.channelTools.getHistory(args as Parameters<typeof this.channelTools.getHistory>[0]);
      case "list_channels":
        return this.channelTools.listChannels();

      // Task tools
      case "task_create":
        return this.taskTools.create(args as Parameters<typeof this.taskTools.create>[0]);
      case "task_update":
        return this.taskTools.update(args as Parameters<typeof this.taskTools.update>[0]);
      case "task_get":
        return this.taskTools.get(args as Parameters<typeof this.taskTools.get>[0]);
      case "task_list":
        return this.taskTools.list(args as Parameters<typeof this.taskTools.list>[0]);
      case "task_history":
        return this.taskTools.getHistory(args as Parameters<typeof this.taskTools.getHistory>[0]);

      // Artifact tools
      case "artifact_register":
        return this.artifactTools.register(args as Parameters<typeof this.artifactTools.register>[0]);
      case "artifact_list":
        return this.artifactTools.list(args as Parameters<typeof this.artifactTools.list>[0]);
      case "artifact_get":
        return this.artifactTools.get(args as Parameters<typeof this.artifactTools.get>[0]);
      case "artifact_notify":
        return this.artifactTools.notify(args as Parameters<typeof this.artifactTools.notify>[0]);
      case "artifact_search":
        return this.artifactTools.search(args as Parameters<typeof this.artifactTools.search>[0]);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async run(): Promise<void> {
    // Check Redis connection
    const isConnected = await this.redis.ping();
    if (!isConnected) {
      console.error("Failed to connect to Redis");
      process.exit(1);
    }

    // Set up graceful shutdown handlers
    this.setupShutdownHandlers();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`${config.server.name} v${config.server.version} running`);
  }

  /**
   * Set up handlers for graceful shutdown on SIGTERM and SIGINT
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        return; // Prevent multiple shutdown attempts
      }
      this.isShuttingDown = true;

      console.error(`\nReceived ${signal}, shutting down gracefully...`);

      try {
        // Close Redis connections
        await this.redis.close();
        console.error("Redis connections closed");
      } catch (error) {
        console.error("Error during shutdown:", error);
      }

      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Handle uncaught exceptions gracefully
    process.on("uncaughtException", async (error) => {
      console.error("Uncaught exception:", error);
      await shutdown("uncaughtException");
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", async (reason) => {
      console.error("Unhandled rejection:", reason);
      // Don't exit on unhandled rejection, just log it
    });
  }
}

// Run the server
const server = new RedisAgentMCPServer();
server.run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
