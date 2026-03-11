import { v4 as uuidv4 } from "uuid";
import { RedisClient } from "../redis-client.js";
import type { ChannelMessage, ChannelInfo } from "../types.js";

const KEYS = {
  CHANNEL_MESSAGES: (channel: string) => `channels:${channel}:messages`,
  CHANNEL_INFO: (channel: string) => `channels:${channel}:info`,
  CHANNEL_SUBSCRIBERS: (channel: string) => `channels:${channel}:subscribers`,
  AGENT_CHANNELS: (agentId: string) => `agents:${agentId}:channels`,
  ALL_CHANNELS: "channels:list",
};

export class ChannelTools {
  constructor(
    private redis: RedisClient,
    private maxChannelHistory: number
  ) {}

  /**
   * Subscribe an agent to a channel
   */
  async subscribe(params: {
    agentId: string;
    channel: string;
  }): Promise<{ success: boolean; channelInfo: ChannelInfo }> {
    const now = Date.now();

    // Add agent to channel subscribers
    await this.redis.sadd(KEYS.CHANNEL_SUBSCRIBERS(params.channel), params.agentId);
    
    // Add channel to agent's subscriptions
    await this.redis.sadd(KEYS.AGENT_CHANNELS(params.agentId), params.channel);
    
    // Add to global channel list
    await this.redis.sadd(KEYS.ALL_CHANNELS, params.channel);

    // Update channel info
    const subscriberCount = await this.redis.scard(KEYS.CHANNEL_SUBSCRIBERS(params.channel));
    const messageCount = await this.redis.llen(KEYS.CHANNEL_MESSAGES(params.channel));

    const channelInfo: ChannelInfo = {
      name: params.channel,
      subscriberCount,
      messageCount,
      lastActivity: now,
    };

    await this.redis.setJson(KEYS.CHANNEL_INFO(params.channel), channelInfo);

    // Publish subscription event
    await this.redis.publish(`channel:${params.channel}`, JSON.stringify({
      type: "subscriber_joined",
      agentId: params.agentId,
      channel: params.channel,
      timestamp: now,
    }));

    return {
      success: true,
      channelInfo,
    };
  }

  /**
   * Unsubscribe an agent from a channel
   */
  async unsubscribe(params: {
    agentId: string;
    channel: string;
  }): Promise<{ success: boolean }> {
    // Remove agent from channel subscribers
    await this.redis.srem(KEYS.CHANNEL_SUBSCRIBERS(params.channel), params.agentId);
    
    // Remove channel from agent's subscriptions
    await this.redis.srem(KEYS.AGENT_CHANNELS(params.agentId), params.channel);

    // Publish unsubscription event
    await this.redis.publish(`channel:${params.channel}`, JSON.stringify({
      type: "subscriber_left",
      agentId: params.agentId,
      channel: params.channel,
      timestamp: Date.now(),
    }));

    return { success: true };
  }

  /**
   * Publish a message to a channel
   */
  async publish(params: {
    agentId: string;
    channel: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ messageId: string; subscriberCount: number; timestamp: number }> {
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

    // Store in channel history
    await this.redis.lpush(KEYS.CHANNEL_MESSAGES(params.channel), JSON.stringify(message));
    await this.redis.ltrim(KEYS.CHANNEL_MESSAGES(params.channel), 0, this.maxChannelHistory - 1);

    // Get subscriber count
    const subscriberCount = await this.redis.scard(KEYS.CHANNEL_SUBSCRIBERS(params.channel));

    // Update channel info
    const channelInfo: ChannelInfo = {
      name: params.channel,
      subscriberCount,
      messageCount: await this.redis.llen(KEYS.CHANNEL_MESSAGES(params.channel)),
      lastActivity: now,
    };
    await this.redis.setJson(KEYS.CHANNEL_INFO(params.channel), channelInfo);

    // Publish to Redis pub/sub for real-time delivery
    await this.redis.publish(`channel:${params.channel}`, JSON.stringify({
      type: "message",
      message: message,
    }));

    return {
      messageId,
      subscriberCount,
      timestamp: now,
    };
  }

  /**
   * Get channel message history
   */
  async getHistory(params: {
    channel: string;
    limit?: number;
    since?: number;
  }): Promise<{ messages: ChannelMessage[]; totalCount: number }> {
    const limit = params.limit || 50;
    const rawMessages = await this.redis.lrange(KEYS.CHANNEL_MESSAGES(params.channel), 0, limit - 1);
    const totalCount = await this.redis.llen(KEYS.CHANNEL_MESSAGES(params.channel));

    const messages: ChannelMessage[] = [];
    for (const raw of rawMessages) {
      try {
        const msg = JSON.parse(raw) as ChannelMessage;
        
        // Filter by timestamp if provided
        if (params.since && msg.timestamp < params.since) {
          continue;
        }
        
        messages.push(msg);
      } catch {
        // Skip invalid
      }
    }

    return { messages, totalCount };
  }

  /**
   * Get channel info
   */
  async getChannelInfo(params: { channel: string }): Promise<ChannelInfo | null> {
    const info = await this.redis.getJson<ChannelInfo>(KEYS.CHANNEL_INFO(params.channel));
    
    if (!info) {
      // Build info from existing data
      const subscriberCount = await this.redis.scard(KEYS.CHANNEL_SUBSCRIBERS(params.channel));
      if (subscriberCount === 0) {
        return null; // Channel doesn't exist
      }

      return {
        name: params.channel,
        subscriberCount,
        messageCount: await this.redis.llen(KEYS.CHANNEL_MESSAGES(params.channel)),
        lastActivity: Date.now(),
      };
    }

    return info;
  }

  /**
   * List all channels
   */
  async listChannels(): Promise<ChannelInfo[]> {
    const channelNames = await this.redis.smembers(KEYS.ALL_CHANNELS);
    const channels: ChannelInfo[] = [];

    for (const name of channelNames) {
      const info = await this.getChannelInfo({ channel: name });
      if (info && info.subscriberCount > 0) {
        channels.push(info);
      }
    }

    return channels;
  }

  /**
   * Get channels an agent is subscribed to
   */
  async getAgentChannels(params: { agentId: string }): Promise<string[]> {
    return this.redis.smembers(KEYS.AGENT_CHANNELS(params.agentId));
  }

  /**
   * Get subscribers of a channel
   */
  async getSubscribers(params: { channel: string }): Promise<string[]> {
    return this.redis.smembers(KEYS.CHANNEL_SUBSCRIBERS(params.channel));
  }
}
