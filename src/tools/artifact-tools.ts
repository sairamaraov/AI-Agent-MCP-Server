import { v4 as uuidv4 } from "uuid";
import { RedisClient } from "../redis-client.js";
import type { Artifact, ArtifactType } from "../types.js";

const KEYS = {
  ARTIFACT: (id: string) => `artifacts:${id}`,
  BY_TYPE: (type: string) => `artifacts:by-type:${type}`,
  BY_OWNER: (owner: string) => `artifacts:by-owner:${owner}`,
  BY_PATH: "artifacts:by-path",
  ALL_ARTIFACTS: "artifacts:all",
};

export class ArtifactTools {
  constructor(private redis: RedisClient) {}

  /**
   * Register a new artifact
   */
  async register(params: {
    path: string;
    type: ArtifactType;
    owner: string;
    description: string;
    version?: string;
  }): Promise<{ artifactId: string; artifact: Artifact }> {
    const now = Date.now();
    
    // Check if artifact with same path exists
    const existingId = await this.redis.hget(KEYS.BY_PATH, params.path);
    
    let artifactId: string;
    let isUpdate = false;
    
    if (existingId) {
      artifactId = existingId;
      isUpdate = true;
    } else {
      artifactId = `artifact-${uuidv4().slice(0, 8)}`;
    }

    const artifact: Artifact = {
      id: artifactId,
      path: params.path,
      type: params.type,
      owner: params.owner,
      description: params.description,
      version: params.version || "1.0.0",
      createdAt: isUpdate ? (await this.get({ artifactId }))?.createdAt || now : now,
      updatedAt: now,
    };

    // Store artifact
    await this.redis.setJson(KEYS.ARTIFACT(artifactId), artifact);

    // Update indexes
    await this.redis.sadd(KEYS.ALL_ARTIFACTS, artifactId);
    await this.redis.sadd(KEYS.BY_TYPE(params.type), artifactId);
    await this.redis.sadd(KEYS.BY_OWNER(params.owner), artifactId);
    await this.redis.hset(KEYS.BY_PATH, params.path, artifactId);

    // Publish event
    await this.redis.publish("events:artifact", JSON.stringify({
      type: isUpdate ? "artifact_updated" : "artifact_created",
      artifact: artifact,
      timestamp: now,
    }));

    return { artifactId, artifact };
  }

  /**
   * Get artifact by ID
   */
  async get(params: { artifactId: string }): Promise<Artifact | null> {
    return this.redis.getJson<Artifact>(KEYS.ARTIFACT(params.artifactId));
  }

  /**
   * Get artifact by path
   */
  async getByPath(params: { path: string }): Promise<Artifact | null> {
    const artifactId = await this.redis.hget(KEYS.BY_PATH, params.path);
    if (!artifactId) return null;
    return this.get({ artifactId });
  }

  /**
   * List artifacts with filters
   */
  async list(params?: {
    type?: ArtifactType;
    owner?: string;
    limit?: number;
  }): Promise<{ artifacts: Artifact[]; totalCount: number }> {
    let artifactIds: string[];

    if (params?.type) {
      artifactIds = await this.redis.smembers(KEYS.BY_TYPE(params.type));
    } else if (params?.owner) {
      artifactIds = await this.redis.smembers(KEYS.BY_OWNER(params.owner));
    } else {
      artifactIds = await this.redis.smembers(KEYS.ALL_ARTIFACTS);
    }

    const artifacts: Artifact[] = [];
    for (const id of artifactIds) {
      const artifact = await this.get({ artifactId: id });
      if (!artifact) continue;

      // Apply additional filters
      if (params?.type && artifact.type !== params.type) continue;
      if (params?.owner && artifact.owner !== params.owner) continue;

      artifacts.push(artifact);
    }

    // Sort by updated date
    artifacts.sort((a, b) => b.updatedAt - a.updatedAt);

    const limit = params?.limit || 50;
    return {
      artifacts: artifacts.slice(0, limit),
      totalCount: artifacts.length,
    };
  }

  /**
   * Update artifact version
   */
  async updateVersion(params: {
    artifactId: string;
    version: string;
    changedBy: string;
    description?: string;
  }): Promise<{ success: boolean; artifact: Artifact | null }> {
    const artifact = await this.get({ artifactId: params.artifactId });
    if (!artifact) {
      return { success: false, artifact: null };
    }

    artifact.version = params.version;
    artifact.updatedAt = Date.now();
    if (params.description) {
      artifact.description = params.description;
    }

    await this.redis.setJson(KEYS.ARTIFACT(params.artifactId), artifact);

    // Publish update event
    await this.redis.publish("events:artifact", JSON.stringify({
      type: "artifact_version_updated",
      artifact: artifact,
      changedBy: params.changedBy,
      timestamp: Date.now(),
    }));

    return { success: true, artifact };
  }

  /**
   * Notify agents about artifact changes
   */
  async notify(params: {
    artifactId: string;
    changeType: "created" | "updated" | "deleted";
    changedBy: string;
    description: string;
    notifyAgents?: string[];
  }): Promise<{ notifiedCount: number }> {
    const artifact = await this.get({ artifactId: params.artifactId });
    if (!artifact && params.changeType !== "deleted") {
      return { notifiedCount: 0 };
    }

    const notification = {
      type: `artifact_${params.changeType}`,
      artifactId: params.artifactId,
      artifact: artifact,
      changeType: params.changeType,
      changedBy: params.changedBy,
      description: params.description,
      timestamp: Date.now(),
    };

    // Broadcast to all or specific agents
    if (params.notifyAgents && params.notifyAgents.length > 0) {
      for (const agentId of params.notifyAgents) {
        await this.redis.publish(`notify:${agentId}`, JSON.stringify(notification));
      }
      return { notifiedCount: params.notifyAgents.length };
    } else {
      // Broadcast to artifact update channel
      await this.redis.publish("events:artifact", JSON.stringify(notification));
      return { notifiedCount: -1 }; // -1 indicates broadcast
    }
  }

  /**
   * Delete an artifact
   */
  async delete(params: {
    artifactId: string;
    deletedBy: string;
  }): Promise<{ success: boolean }> {
    const artifact = await this.get({ artifactId: params.artifactId });
    if (!artifact) {
      return { success: false };
    }

    // Remove from indexes
    await this.redis.srem(KEYS.ALL_ARTIFACTS, params.artifactId);
    await this.redis.srem(KEYS.BY_TYPE(artifact.type), params.artifactId);
    await this.redis.srem(KEYS.BY_OWNER(artifact.owner), params.artifactId);
    await this.redis.hdel(KEYS.BY_PATH, artifact.path);

    // Delete artifact data
    await this.redis.del(KEYS.ARTIFACT(params.artifactId));

    // Publish delete event
    await this.redis.publish("events:artifact", JSON.stringify({
      type: "artifact_deleted",
      artifactId: params.artifactId,
      path: artifact.path,
      deletedBy: params.deletedBy,
      timestamp: Date.now(),
    }));

    return { success: true };
  }

  /**
   * Search artifacts by path pattern
   */
  async search(params: { pathPattern: string }): Promise<Artifact[]> {
    const allPaths = await this.redis.hgetall(KEYS.BY_PATH);
    const artifacts: Artifact[] = [];

    // Safe glob-to-regex: escape all special regex chars except *, then convert * to [^/]*
    // This prevents ReDoS attacks from malicious patterns
    const safePattern = params.pathPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars
      .replace(/\*/g, '[^/]*');                // Convert * to non-greedy match (no path separators)

    let pattern: RegExp;
    try {
      pattern = new RegExp(`^${safePattern}$`, "i");
    } catch {
      // If pattern is still invalid somehow, fall back to literal match
      pattern = new RegExp(`^${params.pathPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i");
    }

    for (const [path, artifactId] of Object.entries(allPaths)) {
      if (pattern.test(path)) {
        const artifact = await this.get({ artifactId });
        if (artifact) {
          artifacts.push(artifact);
        }
      }
    }

    return artifacts;
  }
}
