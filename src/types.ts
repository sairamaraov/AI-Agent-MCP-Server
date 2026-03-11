// Type definitions for Redis Agent MCP Server

export interface AgentInfo {
  id: string;
  role: string;
  name: string;
  capabilities: string[];
  status: AgentStatus;
  currentTask?: string;
  lastSeen: number;
  registeredAt: number;
}

export type AgentStatus = "active" | "busy" | "idle" | "offline";

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  subject: string;
  content: string;
  priority: Priority;
  timestamp: number;
  replyTo?: string;
  metadata?: Record<string, unknown>;
  read?: boolean;
}

export type MessageType = "direct" | "request" | "response" | "notification";
export type Priority = "critical" | "high" | "normal" | "low";

export interface Notification {
  type: "new_message" | "broadcast" | "task_assigned" | "task_updated" | "artifact_updated";
  messageId: string;
  from: string;
  to: string;
  subject: string;
  priority: Priority;
  timestamp: number;
}

export interface ChannelMessage {
  id: string;
  from: string;
  channel: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelInfo {
  name: string;
  subscriberCount: number;
  messageCount: number;
  lastActivity: number;
}

export interface TaskNote {
  agentId: string;
  note: string;
  timestamp: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assignee?: string;
  reporter: string;
  dependencies: string[];
  blockedBy: string[];
  artifacts: string[];
  notes: TaskNote[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type TaskStatus =
  | "pending"
  | "assigned"
  | "in-progress"
  | "review"
  | "blocked"
  | "completed"
  | "cancelled";

export interface TaskEvent {
  taskId: string;
  agentId: string;
  action: string;
  details: string;
  timestamp: number;
}

export interface Artifact {
  id: string;
  path: string;
  type: ArtifactType;
  owner: string;
  description: string;
  version: string;
  createdAt: number;
  updatedAt: number;
}

export type ArtifactType =
  | "api-spec"
  | "component"
  | "test"
  | "documentation"
  | "config"
  | "schema"
  | "design";

export interface TeamStatus {
  agents: AgentInfo[];
  activeCount: number;
  busyCount: number;
  idleCount: number;
  offlineCount: number;
  tasksSummary: {
    pending: number;
    inProgress: number;
    review: number;
    blocked: number;
    completed: number;
  };
}

export interface Config {
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
    keyPrefix: string;
  };
  agent: {
    heartbeatInterval: number;
    heartbeatTTL: number;
    maxMessageHistory: number;
    maxChannelHistory: number;
  };
  server: {
    name: string;
    version: string;
  };
}

// Result types for tool responses
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
