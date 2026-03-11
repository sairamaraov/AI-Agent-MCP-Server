import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createDatabase } from "./db/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const CONFIG = {
  port: process.env.DASHBOARD_PORT || 3456,
  databaseType: 'redis',
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || "0"),
    keyPrefix: process.env.REDIS_PREFIX || "agent-team:",
  },
};

// Initialize database
const db = createDatabase(CONFIG.redis);

// Express app
const app = express();
const server = createServer(app);

// Additional helper functions for transparency
async function getCommunicationGraph() {
  // Build a graph of who communicates with whom
  const agentsData = await db.hgetall("agents:registry");
  const agents = Object.values(agentsData).map(a => {
    try { return typeof a === 'string' ? JSON.parse(a) : a; } catch { return null; }
  }).filter(Boolean);

  const agentIds = agents.map(a => a.id);
  const connections = [];
  const messageCount = {};

  // Analyze all messages to find communication patterns
  for (const agentId of agentIds) {
    const inboxKey = `messages:inbox:${agentId}`;
    const messages = await db.lrange(inboxKey, 0, -1);

    for (const msgJson of messages) {
      try {
        const msg = typeof msgJson === 'string' ? JSON.parse(msgJson) : msgJson;
        const key = `${msg.from}→${msg.to}`;
        messageCount[key] = (messageCount[key] || 0) + 1;
      } catch (e) {
        // Skip invalid
      }
    }
  }

  // Convert to connections array
  for (const [pair, count] of Object.entries(messageCount)) {
    const [from, to] = pair.split('→');
    connections.push({ from, to, messageCount: count });
  }

  return {
    agents: agents.map(a => ({ id: a.id, name: a.name, role: a.role })),
    connections: connections.sort((a, b) => b.messageCount - a.messageCount),
    totalConnections: connections.length,
    totalMessages: Object.values(messageCount).reduce((a, b) => a + b, 0),
  };
}

async function getRecord(key) {
  const keyType = await db.type(key);
  if (keyType === 'none') return null;
  if (keyType === 'string') return await db.get(key);
  if (keyType === 'hash') return await db.hgetall(key);
  return null;
}

async function getAgentWorkload() {
  // Track what each agent is working on
  const agentsData = await db.hgetall("agents:registry");
  const agents = [];

  for (const [agentId, agentJson] of Object.entries(agentsData)) {
    try {
      const agent = typeof agentJson === 'string' ? JSON.parse(agentJson) : agentJson;
      const taskIds = await db.smembers(`tasks:by-agent:${agentId}`);
      const tasksWithStatus = await Promise.all(
        taskIds.map(async (taskId) => {
          return await getRecord(`tasks:${taskId}`);
        })
      );

      const tasks = tasksWithStatus.filter(Boolean);
      const inboxKey = `messages:inbox:${agentId}`;
      const unreadMessages = await db.llen(inboxKey);

      agents.push({
        id: agentId,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        taskCount: taskIds.length,
        tasksByStatus: {
          'in-progress': tasks.filter(t => t.status === 'in-progress').length,
          'review': tasks.filter(t => t.status === 'review').length,
          'pending': tasks.filter(t => t.status === 'pending' || t.status === 'assigned').length,
          'blocked': tasks.filter(t => t.status === 'blocked').length,
          'completed': tasks.filter(t => t.status === 'completed').length,
        },
        unreadMessages,
        capabilities: agent.capabilities || [],
      });
    } catch (e) {
      // Skip invalid
    }
  }

  return agents.sort((a, b) => b.taskCount - a.taskCount);
}

async function getMessageChains() {
  // Track request-response pairs and message threads
  const agentsData = await db.hgetall("agents:registry");
  const allMessages = [];

  // Collect all messages
  for (const agentId of Object.keys(agentsData)) {
    const inboxKey = `messages:inbox:${agentId}`;
    const messages = await db.lrange(inboxKey, 0, -1);

    for (const msgJson of messages) {
      try {
        allMessages.push(typeof msgJson === 'string' ? JSON.parse(msgJson) : msgJson);
      } catch (e) {
        // Skip invalid
      }
    }
  }

  // Sort by timestamp
  allMessages.sort((a, b) => a.timestamp - b.timestamp);

  // Group into chains (messages with "RE:" are responses)
  const chains = [];
  const chainMap = {};

  for (const msg of allMessages) {
    if (msg.subject.startsWith('RE:')) {
      // This is a response
      const originalSubject = msg.subject.replace('RE: ', '');
      const existingChain = chains.find(c => c.subject === originalSubject);

      if (existingChain) {
        existingChain.messages.push(msg);
        existingChain.lastUpdate = msg.timestamp;
      }
    } else if (!chainMap[msg.subject]) {
      // Start of a new chain
      const chain = {
        subject: msg.subject,
        initiator: msg.from,
        messages: [msg],
        participants: new Set([msg.from, msg.to]),
        firstMessage: msg.timestamp,
        lastUpdate: msg.timestamp,
      };
      chains.push(chain);
      chainMap[msg.subject] = chain;
    } else {
      // Add to existing chain
      const chain = chainMap[msg.subject];
      chain.messages.push(msg);
      chain.participants.add(msg.from);
      chain.participants.add(msg.to);
      chain.lastUpdate = msg.timestamp;
    }
  }

  // Convert Sets to arrays and return
  return chains
    .map(c => ({
      subject: c.subject,
      initiator: c.initiator,
      participants: Array.from(c.participants),
      messageCount: c.messages.length,
      firstMessage: new Date(c.firstMessage).toISOString(),
      lastUpdate: new Date(c.lastUpdate).toISOString(),
      types: [...new Set(c.messages.map(m => m.type))],
    }))
    .sort((a, b) => b.lastUpdate - a.lastUpdate);
}

// WebSocket server
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(join(__dirname, "public")));

// API Routes
app.get("/api/team-status", async (req, res) => {
  try {
    const status = await getTeamStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tasks", async (req, res) => {
  try {
    const tasks = await getAllTasks();
    console.log(`[API] /api/tasks - Returning ${tasks.tasks.length} tasks`);
    res.json(tasks);
  } catch (error) {
    console.error("[API] /api/tasks - Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/messages/recent", async (req, res) => {
  try {
    const messages = await getRecentMessages();
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/activity", async (req, res) => {
  try {
    const activity = await getActivityLog();
    console.log(`[API] /api/activity - Returning ${activity.length} activities`);
    res.json(activity);
  } catch (error) {
    console.error("[API] /api/activity - Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/artifacts", async (req, res) => {
  try {
    const artifacts = await getArtifacts();
    res.json(artifacts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/communication-graph", async (req, res) => {
  try {
    const graph = await getCommunicationGraph();
    res.json(graph);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/agent-workload", async (req, res) => {
  try {
    const workload = await getAgentWorkload();
    res.json(workload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/message-chains", async (req, res) => {
  try {
    const chains = await getMessageChains();
    res.json(chains);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper functions
async function getTeamStatus() {
  const agentsData = await db.hgetall("agents:registry");
  const agents = [];

  for (const [agentId, agentJson] of Object.entries(agentsData)) {
    try {
      const agent = typeof agentJson === 'string' ? JSON.parse(agentJson) : agentJson;
      // Check presence
      const presenceKey = `agents:presence:${agentId}`;
      const isOnline = await db.exists(presenceKey);
      agent.isOnline = isOnline === 1;
      if (!agent.isOnline) {
        agent.status = "offline";
      }
      agents.push(agent);
    } catch (e) {
      // Skip invalid entries
    }
  }

  const activeCount = agents.filter((a) => a.status === "active").length;
  const busyCount = agents.filter((a) => a.status === "busy").length;
  const idleCount = agents.filter((a) => a.status === "idle").length;
  const offlineCount = agents.filter((a) => a.status === "offline").length;

  return {
    agents,
    summary: {
      total: agents.length,
      active: activeCount,
      busy: busyCount,
      idle: idleCount,
      offline: offlineCount,
    },
  };
}

async function getAllTasks() {
  const taskIds = await db.smembers("tasks:all");
  const tasks = [];

  for (const taskId of taskIds) {
    try {
      const task = await getRecord(`tasks:${taskId}`);
      if (task) tasks.push(task);
    } catch (e) {
      console.error(`[getAllTasks] Error processing task ${taskId}:`, e.message);
    }
  }

  // Sort by priority and date
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  tasks.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return b.createdAt - a.createdAt;
  });

  // Summary by status
  const summary = {
    pending: tasks.filter((t) => t.status === "pending" || t.status === "assigned").length,
    inProgress: tasks.filter((t) => t.status === "in-progress").length,
    review: tasks.filter((t) => t.status === "review").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    cancelled: tasks.filter((t) => t.status === "cancelled").length,
  };

  return { tasks, summary };
}

async function getRecentMessages() {
  // Get all agent IDs
  const agentsData = await db.hgetall("agents:registry");
  const allMessages = [];

  for (const agentId of Object.keys(agentsData)) {
    const inboxKey = `messages:inbox:${agentId}`;
    const messages = await db.lrange(inboxKey, 0, 19);

    for (const msgJson of messages) {
      try {
        const msg = typeof msgJson === 'string' ? JSON.parse(msgJson) : msgJson;
        allMessages.push(msg);
      } catch (e) {
        // Skip invalid
      }
    }
  }

  // Sort by timestamp, most recent first
  allMessages.sort((a, b) => b.timestamp - a.timestamp);

  // Return last 50
  return allMessages.slice(0, 50);
}

async function getActivityLog() {
  const activities = [];

  // 1. Get task events from all tasks
  const taskIds = await db.smembers("tasks:all");
  for (const taskId of taskIds) {
    const historyKey = `tasks:${taskId}:history`;
    const events = await db.lrange(historyKey, 0, 9);

    for (const eventJson of events) {
      try {
        const event = typeof eventJson === 'string' ? JSON.parse(eventJson) : eventJson;
        activities.push({
          type: "task",
          action: event.action || "Task update",
          details: event.details || "",
          agentId: event.agentId || "system",
          timestamp: event.timestamp || Date.now(),
          ...event,
        });
      } catch (e) {
        // Skip invalid
      }
    }
  }

  // 2. Get recent messages as activity
  const agentsData = await db.hgetall("agents:registry");
  for (const agentId of Object.keys(agentsData)) {
    const inboxKey = `messages:inbox:${agentId}`;
    const messages = await db.lrange(inboxKey, 0, 4);

    for (const msgJson of messages) {
      try {
        const msg = typeof msgJson === 'string' ? JSON.parse(msgJson) : msgJson;
        activities.push({
          type: "message",
          action: `Message: ${msg.subject}`,
          details: `${msg.from} → ${msg.to}: ${msg.content}`,
          agentId: msg.from,
          timestamp: msg.timestamp || Date.now(),
        });
      } catch (e) {
        // Skip invalid
      }
    }
  }

  // 3. Get artifact updates
  const artifactIds = await db.smembers("artifacts:all");
  for (const artifactId of artifactIds) {
    try {
      const artifact = await getRecord(`artifacts:${artifactId}`);
      if (artifact && artifact.updatedAt) {
        activities.push({
          type: "artifact",
          action: "Artifact updated",
          details: `${artifact.path} - ${artifact.description}`,
          agentId: artifact.owner,
          timestamp: artifact.updatedAt,
        });
      }
    } catch (e) {
      console.error(`[getActivityLog] Error processing artifact ${artifactId}:`, e.message);
    }
  }

  // Sort by timestamp, most recent first
  activities.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return activities.slice(0, 100);
}

async function getArtifacts() {
  const artifactIds = await db.smembers("artifacts:all");
  const artifacts = [];

  for (const artifactId of artifactIds) {
    try {
      const artifact = await getRecord(`artifacts:${artifactId}`);
      if (artifact) artifacts.push(artifact);
    } catch (e) {
      console.error(`[getArtifacts] Error processing artifact ${artifactId}:`, e.message);
    }
  }

  // Sort by updated date
  artifacts.sort((a, b) => b.updatedAt - a.updatedAt);

  return artifacts;
}

// WebSocket handling
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("Dashboard client connected");

  ws.on("close", () => {
    clients.delete(ws);
    console.log("Dashboard client disconnected");
  });

  // Send initial data
  sendInitialData(ws);
});

async function sendInitialData(ws) {
  try {
    const [teamStatus, tasks, messages, activity] = await Promise.all([
      getTeamStatus(),
      getAllTasks(),
      getRecentMessages(),
      getActivityLog(),
    ]);

    console.log(`[WebSocket] Sending initial data:`);
    console.log(`  - Agents: ${teamStatus.agents.length}`);
    console.log(`  - Tasks: ${tasks.tasks.length}`);
    console.log(`  - Messages: ${messages.length}`);
    console.log(`  - Activities: ${activity.length}`);

    ws.send(
      JSON.stringify({
        type: "initial",
        data: { teamStatus, tasks, messages, activity },
      })
    );
  } catch (error) {
    console.error("Error sending initial data:", error);
  }
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) {
      // OPEN
      client.send(data);
    }
  }
}

// Subscribe to pub/sub for real-time updates
await db.connect();

// Redis uses pattern subscriptions
await db.psubscribe('events:*', async (message) => {
  try {
    const data = typeof message === 'string' ? JSON.parse(message) : message;
    broadcast({
      type: "event",
      data,
    });
    if (data.type === "agent_joined" || data.type === "agent_left") {
      const teamStatus = await getTeamStatus();
      broadcast({ type: "teamStatus", data: teamStatus });
    }
  } catch (e) {
    // Ignore parse errors
  }
});

await db.psubscribe('notify:*', async (message) => {
  try {
    const data = typeof message === 'string' ? JSON.parse(message) : message;
    broadcast({ type: "event", data });
  } catch (e) {
    // Ignore parse errors
  }
});

await db.psubscribe('channel:*', async (message) => {
  try {
    const data = typeof message === 'string' ? JSON.parse(message) : message;
    broadcast({ type: "event", data });
  } catch (e) {
    // Ignore parse errors
  }
});

// Periodic refresh of team status (to catch heartbeat expirations)
setInterval(async () => {
  try {
    const teamStatus = await getTeamStatus();
    broadcast({ type: "teamStatus", data: teamStatus });
  } catch (e) {
    console.error("Refresh error:", e);
  }
}, 5000);

// Start server
server.listen(CONFIG.port, async () => {
  const dbInfo = `Redis:     ${CONFIG.redis.host}:${CONFIG.redis.port}`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Agent Team Dashboard                                ║
╠══════════════════════════════════════════════════════════════╣
║  Dashboard: http://localhost:${CONFIG.port}                        ║
║  Database:  ${CONFIG.databaseType.toUpperCase()}                                    ║
║  ${dbInfo}                    ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
