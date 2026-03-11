import { v4 as uuidv4 } from "uuid";
import { RedisClient } from "../redis-client.js";
import type { Message, MessageType, Priority, AgentInfo, Notification } from "../types.js";

const KEYS = {
  INBOX: (id: string) => `messages:inbox:${id}`,
  SENT: (id: string) => `messages:sent:${id}`,
  THREAD: (id: string) => `messages:thread:${id}`,
  REGISTRY: "agents:registry",
};

export class MessageTools {
  constructor(
    private redis: RedisClient,
    private maxMessageHistory: number
  ) {}

  /**
   * Send a direct message to another agent
   */
  async sendMessage(params: {
    from: string;
    to: string;
    subject: string;
    content: string;
    type?: MessageType;
    priority?: Priority;
    replyTo?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ messageId: string; delivered: boolean; timestamp: number }> {
    const now = Date.now();
    const messageId = uuidv4();

    const message: Message = {
      id: messageId,
      from: params.from,
      to: params.to,
      type: params.type || "direct",
      subject: params.subject,
      content: params.content,
      priority: params.priority || "normal",
      timestamp: now,
      replyTo: params.replyTo,
      metadata: params.metadata,
      read: false,
    };

    // Add to recipient's inbox
    await this.redis.lpush(KEYS.INBOX(params.to), JSON.stringify(message));
    
    // Trim inbox to max size
    await this.redis.ltrim(KEYS.INBOX(params.to), 0, this.maxMessageHistory - 1);

    // Add to sender's sent box
    await this.redis.lpush(KEYS.SENT(params.from), JSON.stringify(message));
    await this.redis.ltrim(KEYS.SENT(params.from), 0, this.maxMessageHistory - 1);

    // If this is a reply, add to thread
    if (params.replyTo) {
      await this.redis.lpush(KEYS.THREAD(params.replyTo), JSON.stringify(message));
    }

    // Push to notification queue for immediate delivery (BLPOP-friendly)
    await this.redis.lpush(`notifications:${params.to}`, JSON.stringify({
      type: "new_message",
      messageId: messageId,
      from: params.from,
      to: params.to,
      subject: params.subject,
      priority: params.priority || "normal",
      timestamp: now,
    }));

    // Publish real-time notification
    await this.redis.publish(`notify:${params.to}`, JSON.stringify({
      type: "new_message",
      message: message,
    }));

    // Also publish to general message events
    await this.redis.publish("events:message", JSON.stringify({
      type: "message_sent",
      from: params.from,
      to: params.to,
      messageId: messageId,
      subject: params.subject,
      priority: params.priority || "normal",
      timestamp: now,
    }));

    return {
      messageId,
      delivered: true,
      timestamp: now,
    };
  }

  /**
   * Get messages for an agent
   */
  async getMessages(params: {
    agentId: string;
    limit?: number;
    since?: number;
    type?: "inbox" | "sent";
  }): Promise<{ messages: Message[]; totalCount: number }> {
    const limit = params.limit || 20;
    const key = params.type === "sent" 
      ? KEYS.SENT(params.agentId) 
      : KEYS.INBOX(params.agentId);

    const rawMessages = await this.redis.lrange(key, 0, limit - 1);
    const totalCount = await this.redis.llen(key);

    const messages: Message[] = [];
    for (const raw of rawMessages) {
      try {
        const msg = JSON.parse(raw) as Message;
        
        // Filter by timestamp if provided
        if (params.since && msg.timestamp < params.since) {
          continue;
        }
        
        messages.push(msg);
      } catch {
        // Skip invalid messages
      }
    }

    return { messages, totalCount };
  }

  /**
   * Broadcast message to all agents or a specific role
   */
  async broadcastMessage(params: {
    from: string;
    subject: string;
    content: string;
    targetRole?: string;
    priority?: Priority;
  }): Promise<{ messageId: string; recipientCount: number; timestamp: number }> {
    const now = Date.now();
    const messageId = uuidv4();

    // Get all agents
    const registry = await this.redis.hgetall(KEYS.REGISTRY);
    let recipientCount = 0;

    const message: Message = {
      id: messageId,
      from: params.from,
      to: params.targetRole ? `role:${params.targetRole}` : "broadcast:all",
      type: "notification",
      subject: params.subject,
      content: params.content,
      priority: params.priority || "normal",
      timestamp: now,
      read: false,
    };

    for (const [agentId, data] of Object.entries(registry)) {
      try {
        const agent = JSON.parse(data) as AgentInfo;
        
        // Skip sender
        if (agentId === params.from) continue;
        
        // Filter by role if specified
        if (params.targetRole && agent.role !== params.targetRole) continue;

        // Deliver to each recipient
        const recipientMessage = { ...message, to: agentId };
        await this.redis.lpush(KEYS.INBOX(agentId), JSON.stringify(recipientMessage));
        await this.redis.ltrim(KEYS.INBOX(agentId), 0, this.maxMessageHistory - 1);

        recipientCount++;

        // Push to notification queue for immediate delivery
        await this.redis.lpush(`notifications:${agentId}`, JSON.stringify({
          type: "broadcast",
          messageId: messageId,
          from: params.from,
          to: agentId,
          subject: params.subject,
          priority: params.priority || "normal",
          timestamp: now,
        }));

        // Notify recipient
        await this.redis.publish(`notify:${agentId}`, JSON.stringify({
          type: "broadcast",
          message: recipientMessage,
        }));
      } catch {
        // Skip invalid agents
      }
    }

    // Publish broadcast event
    const channel = params.targetRole 
      ? `broadcast:role:${params.targetRole}` 
      : "broadcast:all";
    
    await this.redis.publish(channel, JSON.stringify({
      type: "broadcast",
      message: message,
      recipientCount,
    }));

    return {
      messageId,
      recipientCount,
      timestamp: now,
    };
  }

  /**
   * Get message thread (conversation)
   */
  async getThread(params: {
    messageId: string;
    limit?: number;
  }): Promise<{ messages: Message[] }> {
    const limit = params.limit || 50;
    const rawMessages = await this.redis.lrange(KEYS.THREAD(params.messageId), 0, limit - 1);

    const messages: Message[] = [];
    for (const raw of rawMessages) {
      try {
        messages.push(JSON.parse(raw) as Message);
      } catch {
        // Skip invalid
      }
    }

    return { messages };
  }

  /**
   * Mark message as read
   */
  async markAsRead(params: {
    agentId: string;
    messageId: string;
  }): Promise<{ success: boolean }> {
    // Get all messages, update the one, and rewrite
    // Note: In production, you might want a better structure for this
    const rawMessages = await this.redis.lrange(KEYS.INBOX(params.agentId), 0, -1);
    
    const updatedMessages: string[] = [];
    let found = false;
    
    for (const raw of rawMessages) {
      try {
        const msg = JSON.parse(raw) as Message;
        if (msg.id === params.messageId) {
          msg.read = true;
          found = true;
        }
        updatedMessages.push(JSON.stringify(msg));
      } catch {
        updatedMessages.push(raw);
      }
    }

    if (found) {
      // Clear and rewrite inbox
      await this.redis.del(KEYS.INBOX(params.agentId));
      if (updatedMessages.length > 0) {
        await this.redis.rpush(KEYS.INBOX(params.agentId), ...updatedMessages);
      }
    }

    return { success: found };
  }

  /**
   * Get unread message count
   */
  async getUnreadCount(params: { agentId: string }): Promise<{ count: number }> {
    const rawMessages = await this.redis.lrange(KEYS.INBOX(params.agentId), 0, -1);

    let count = 0;
    for (const raw of rawMessages) {
      try {
        const msg = JSON.parse(raw) as Message;
        if (!msg.read) count++;
      } catch {
        // Skip invalid
      }
    }

    return { count };
  }

  /**
   * Wait for new messages (blocking with timeout)
   * Uses BLPOP for efficient real-time delivery
   */
  async waitForMessages(params: {
    agentId: string;
    timeout?: number;
    includeMessages?: boolean;
  }): Promise<{
    notifications: Notification[];
    messages?: Message[];
    timedOut: boolean;
  }> {
    const timeout = Math.min(params.timeout || 30, 300); // Max 5 minutes
    const notifications: Notification[] = [];
    const notificationKey = `notifications:${params.agentId}`;

    // Use BLPOP to wait for notifications
    const result = await this.redis.blpop(notificationKey, timeout);

    if (result) {
      // Got a notification!
      try {
        const notification = JSON.parse(result[1]) as Notification;
        notifications.push(notification);
      } catch {
        // Skip invalid notification
      }

      // Drain any additional notifications that arrived (non-blocking)
      // This creates a small batch window to reduce tool calls
      let drainCount = 0;
      while (drainCount < 100) { // Limit to prevent infinite loop
        const rawNotification = await this.redis.lpop(notificationKey);
        if (!rawNotification) break;

        try {
          const notification = JSON.parse(rawNotification) as Notification;
          notifications.push(notification);
          drainCount++;
        } catch {
          // Skip invalid
        }
      }
    }

    // Optionally fetch full message content
    let messages: Message[] | undefined;
    if (params.includeMessages && notifications.length > 0) {
      const messageIds = new Set(notifications.map(n => n.messageId));
      const allMessages = await this.getMessages({
        agentId: params.agentId,
        limit: 100
      });

      messages = allMessages.messages.filter(m => messageIds.has(m.id));
    }

    return {
      notifications,
      messages,
      timedOut: notifications.length === 0,
    };
  }
}
