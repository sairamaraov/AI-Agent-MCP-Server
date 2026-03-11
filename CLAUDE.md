# ClaudeAgentMCPServer

MCP (Model Context Protocol) server enabling AI agent team collaboration. Provides agent registration, messaging, task management, and artifact sharing via Redis pub/sub. Includes a real-time web dashboard for monitoring.

## Tech Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript 5.3
- **Protocol**: Model Context Protocol (@modelcontextprotocol/sdk)
- **Backend**: Redis (ioredis) or SQLite (better-sqlite3)
- **Dashboard**: Express.js + WebSocket + Vue-like reactive UI

## Directory Structure

```
ClaudeAgentMCPServer/
├── src/                          # MCP Server (TypeScript)
│   ├── index.ts                 # Main server + tool definitions
│   ├── types.ts                 # Type definitions
│   ├── redis-client.ts          # Redis wrapper
│   └── tools/                   # Tool implementations
│       ├── agent-tools.ts       # Agent management
│       ├── message-tools.ts     # Direct messaging
│       ├── channel-tools.ts     # Pub/sub channels
│       ├── task-tools.ts        # Task lifecycle
│       └── artifact-tools.ts    # Artifact sharing
├── dist/                         # Compiled JavaScript
├── dashboard/                    # Web dashboard
│   ├── server.js               # Express + WebSocket
│   ├── public/index.html       # Frontend UI
│   └── db/                     # Database abstraction
│       ├── DatabaseAdapter.js  # Base interface
│       ├── RedisAdapter.js     # Redis implementation
│       └── SqliteAdapter.js    # SQLite implementation
├── agent-prompts/               # Agent role templates
│   ├── _base-protocol.md       # Base communication protocol
│   └── full-prompts/           # 15 agent role prompts
├── mcp-config.json             # MCP configuration
└── package.json
```

## Quick Start

```bash
# First-time setup
npm install                    # Install dependencies
npm run build                  # Compile TypeScript to ./dist

# Start MCP server + dashboard
npm start
# → MCP server ready on stdio
# → Dashboard available at http://localhost:3456
```

## Common Commands

```bash
npm install          # Install dependencies (first time)
npm run build        # Compile TypeScript to ./dist
npm start            # Start MCP server + dashboard (port 3456)

# Development
npm run dev          # Development with tsx (live reload)
npm run watch        # TypeScript watch mode (no reload)

# Packaging
npm run package:win    # Create Windows .exe
npm run package:linux  # Create Linux binary
npm run package:macos  # Create macOS binary
npm run package:all    # All platforms
```

### Full Workflow
```bash
# Terminal 1: Start MCP server
npm install
npm run build
npm start
# → Listen on stdio (for Claude Desktop)
# → Dashboard at http://localhost:3456

# Terminal 2: Use in Claude Desktop or test
# → Claude Desktop → Settings → Claude.json
# → Add "dist/index.js" to mcpServers
# → Use tools: agent_register, task_create, etc.

# View dashboard in browser
open http://localhost:3456
```

## MCP Tools (35+ Available)

### Agent Management
```typescript
agent_register    // Register agent with team
agent_heartbeat   // Update presence (5min TTL)
agent_deregister  // Leave team gracefully
team_status       // Get all agents and task counts
agent_status      // Get specific agent details
list_agents       // Filter by role or status
```

### Messaging
```typescript
send_message      // Direct P2P message
get_messages      // Retrieve inbox/sent
broadcast_message // Broadcast to all/role
get_unread_count  // Count unread messages
wait_for_messages // Blocking wait (BLPOP)
```

### Channels (Pub/Sub)
```typescript
channel_subscribe   // Join channel
channel_unsubscribe // Leave channel
channel_publish     // Broadcast to channel
channel_history     // Get recent messages
list_channels       // List active channels
```

### Tasks
```typescript
task_create   // Create new task
task_update   // Update status/assignee
task_get      // Get task details
task_list     // Filter by status/assignee
task_history  // Get task events
```

### Artifacts
```typescript
artifact_register  // Register shared artifact
artifact_list      // Filter by type/owner
artifact_get       // Get artifact metadata
artifact_search    // Find by path pattern
artifact_notify    // Notify of changes
```

## Agent Communication Protocol

### Startup Sequence
```typescript
// 1. Register with team
agent_register({
  agentId: "frontend-1",
  role: "frontend-engineer",
  name: "Frontend Developer 1",
  capabilities: ["react", "typescript", "css"]
});

// 2. Check team status
team_status();

// 3. Check messages
get_messages({ agentId: "frontend-1" });

// 4. Subscribe to channels
channel_subscribe({ agentId: "frontend-1", channel: "frontend" });

// 5. Periodic heartbeat
agent_heartbeat({ agentId: "frontend-1", status: "active" });
```

### Message Types
| Type | Description |
|------|-------------|
| `request` | Task assignment or question |
| `response` | Answer to a request |
| `notification` | FYI broadcast |
| `direct` | Direct message |

### Priority Levels
| Priority | Description |
|----------|-------------|
| `critical` | Immediate attention |
| `high` | Important |
| `normal` | Standard |
| `low` | When available |

## Team Hierarchy

```
(Human Owner)
└── cto
    ├── tech-lead
    │   ├── frontend-lead
    │   │   ├── frontend-1, frontend-2
    │   │   └── ui-designer
    │   └── backend-lead
    │       ├── backend-1, backend-2
    │       └── db-admin
    ├── devops-lead
    ├── security-lead
    └── qa-lead
        └── qa-1, qa-2
```

### Agent Roles
| ID | Role | Capabilities |
|----|------|--------------|
| `cto` | Chief Technology Officer | architecture, strategy, leadership |
| `tech-lead` | Technical Lead | project-management, code-review |
| `frontend-lead` | Frontend Lead | react, nextjs, ui-architecture |
| `backend-lead` | Backend Lead | nodejs, postgresql, api-design |
| `frontend-1/2` | Frontend Dev | react, typescript, css |
| `backend-1/2` | Backend Dev | nodejs, postgresql, testing |
| `devops-lead` | DevOps Lead | aws, docker, kubernetes, ci-cd |
| `qa-lead` | QA Lead | test-strategy, automation |
| `ui-designer` | UI/UX Designer | figma, design-systems |
| `db-admin` | Database Admin | postgresql, optimization |
| `security-lead` | Security Lead | audits, threat-modeling |

## Task Lifecycle

```
pending → assigned → in-progress → review → completed
                         ↓
                      blocked → (resolved) → in-progress
                         ↓
                     cancelled
```

### Task Structure
```typescript
interface Task {
  taskId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'critical' | 'high' | 'normal' | 'low';
  assignee?: string;
  reporter: string;
  blockers?: string[];
  artifacts?: string[];
  createdAt: string;
  updatedAt: string;
}
```

## Artifact Types

| Type | Description |
|------|-------------|
| `api-spec` | API specifications (OpenAPI) |
| `component` | UI components |
| `test` | Test files |
| `documentation` | Docs |
| `config` | Configuration files |
| `schema` | Database schemas |
| `design` | Design files |

## Redis Data Structures

### Keys
```
agents:registry              # Hash: all agents
agents:presence:{id}         # String (TTL): heartbeat
agents:channels:{id}         # Set: subscribed channels
messages:inbox:{id}          # List: inbox
messages:sent:{id}           # List: sent
messages:thread:{id}         # List: thread replies
tasks:{id}                   # Hash: task data
tasks:by-status:{status}     # Set: task IDs
artifacts:{id}               # String (JSON): artifact
channels:{name}:subscribers  # Set: subscribers
channels:{name}:messages     # List: history
```

### Pub/Sub Channels
```
events:agent      # Agent join/leave
events:message    # Message sent
events:task       # Task updates
events:artifact   # Artifact changes
notify:{agentId}  # Real-time notifications
```

## Dashboard

### REST API
```
GET /api/team-status         # All agents
GET /api/tasks               # All tasks
GET /api/messages/recent     # 50 recent messages
GET /api/communication-graph # Who talks to whom
GET /api/agent-workload      # Per-agent breakdown
GET /api/artifacts           # All artifacts
GET /api/activity            # Activity feed
```

### WebSocket
- Auto-refresh every 10 seconds
- Real-time agent status updates
- Live task/message notifications

### UI Features
- Team status overview
- Communication graph visualization
- Agent workload breakdown
- Message board with threading
- Task kanban board
- Artifact browser
- Activity feed

## Database Backends

### Redis (Default)
```bash
DATABASE_TYPE=redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PREFIX=agent-team:
```

### SQLite (Embedded)
```bash
DATABASE_TYPE=sqlite
SQLITE_PATH=./data/agent-team.db
SQLITE_POLL_INTERVAL=500  # Pub/sub polling ms
```

## Environment Variables

Create a `.env` file:

```bash
# Database Backend (choose one)
DATABASE_TYPE=redis              # redis or sqlite

# Redis Backend (Recommended for production)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=                  # Leave empty if no auth
REDIS_DB=0
REDIS_PREFIX=agent-team:

# SQLite Backend (Good for development/testing)
SQLITE_PATH=./data/agent-team.db
SQLITE_IN_MEMORY=false           # Set true for in-memory (test only)
SQLITE_POLL_INTERVAL=500         # Polling interval in ms (lower = faster)

# Dashboard
DASHBOARD_PORT=3456
```

### Database Backend Selection
| Use Case | Backend | Why |
|----------|---------|-----|
| Development | SQLite | Embedded, no setup required |
| Local testing | SQLite | Fast, file-based, easy reset |
| Production | Redis | True pub/sub, horizontal scaling, persistent |

**For development:**
```bash
DATABASE_TYPE=sqlite
SQLITE_PATH=./data/agent-team.db
```

**For production with Redis:**
```bash
DATABASE_TYPE=redis
REDIS_HOST=redis.example.com
REDIS_PORT=6379
```

## MCP Configuration

### Claude Desktop (`mcp-config.json`)
```json
{
  "mcpServers": {
    "redis-agent-mcp": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "REDIS_HOST": "localhost",
        "REDIS_PORT": "6379"
      }
    }
  }
}
```

## Type Definitions

### AgentInfo
```typescript
interface AgentInfo {
  agentId: string;
  role: string;
  name: string;
  capabilities: string[];
  status: 'active' | 'busy' | 'idle' | 'offline';
  currentTask?: string;
  lastHeartbeat: string;
}
```

### Message
```typescript
interface Message {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  type: 'request' | 'response' | 'notification' | 'direct';
  priority: 'critical' | 'high' | 'normal' | 'low';
  replyTo?: string;
  timestamp: string;
  read: boolean;
}
```

### Artifact
```typescript
interface Artifact {
  artifactId: string;
  path: string;
  type: ArtifactType;
  owner: string;
  description: string;
  version: string;
  createdAt: string;
  updatedAt: string;
}
```

## Example Workflow

```typescript
// 1. Frontend lead creates task
task_create({
  title: "Build User Profile Component",
  description: "React component with avatar, name, settings",
  priority: "high",
  reporter: "frontend-lead",
  assignee: "frontend-1"
});

// 2. Developer picks up task
task_update({
  taskId: "task-abc123",
  status: "in-progress",
  notes: "Starting implementation"
});

// 3. Developer registers artifact
artifact_register({
  path: "src/components/UserProfile.tsx",
  type: "component",
  owner: "frontend-1",
  description: "Reusable user profile component",
  version: "1.0.0"
});

// 4. Developer requests review
send_message({
  from: "frontend-1",
  to: "frontend-lead",
  subject: "UserProfile ready for review",
  type: "request",
  priority: "normal"
});

// 5. Lead reviews and approves
task_update({
  taskId: "task-abc123",
  status: "completed",
  notes: "Approved - great work!"
});
```

## Agent Prompts

Located in `agent-prompts/full-prompts/`:

1. `01-cto.md` - Chief Technology Officer
2. `02-tech-lead.md` - Technical Lead
3. `03-frontend-lead.md` - Frontend Team Lead
4. `04-backend-lead.md` - Backend Team Lead
5. `05-frontend-1.md` - Frontend Developer 1
6. `06-frontend-2.md` - Frontend Developer 2
7. `07-backend-1.md` - Backend Developer 1
8. `08-backend-2.md` - Backend Developer 2
9. `09-devops-lead.md` - DevOps Lead
10. `10-qa-lead.md` - QA Lead
11. `11-qa-1.md` - QA Engineer 1
12. `12-qa-2.md` - QA Engineer 2
13. `13-ui-designer.md` - UI/UX Designer
14. `14-db-admin.md` - Database Administrator
15. `15-security-lead.md` - Security Lead

## Agent Coordination Patterns

### Avoiding Race Conditions
When multiple agents work on the same task simultaneously:

```typescript
// ❌ BAD: Both agents might accept same task
task_get("task-123");  // Check task
task_update("task-123", { status: "assigned", assignee: "me" });

// ✅ GOOD: Use optimistic locking
task_update("task-123", {
  status: "assigned",
  assignee: "frontend-1",
  expectedStatus: "pending"  // Only update if still pending
});
```

### Task Dependencies
Create blockers when task B depends on task A:

```typescript
// Task A: Design component
task_create({ title: "Design UserProfile component", ... });

// Task B: Implement component (blocked until A completes)
task_create({
  title: "Implement UserProfile component",
  blockedBy: ["task-A-id"]
});

// When A completes:
task_update("task-A-id", { status: "completed" });
// Task B automatically unblocks and becomes "pending"
```

### Broadcasting vs Direct Messages
```typescript
// Use broadcast for team announcements
broadcast_message({
  from: "frontend-lead",
  subject: "Release v2.1 is live!",
  type: "notification",
  priority: "high"
});

// Use direct messages for requests
send_message({
  from: "tech-lead",
  to: "frontend-1",
  subject: "Review PR #456",
  type: "request",
  priority: "high"
});
```

### Channel Subscription (One-Time Setup)
```typescript
// Subscribe once on startup, messages auto-received
channel_subscribe({
  agentId: "frontend-1",
  channel: "frontend",
  backlog: 50  // Get last 50 messages
});

// Later, publish to channel
channel_publish({
  channel: "frontend",
  message: "Tailwind upgrade to v4 ready for review"
});
```

## Important Notes

1. **Heartbeat Required**: Agents must send heartbeat every 5min to stay "active"
   - Missing heartbeat → agent shows "offline" after 5min
   - Dashboard auto-removes offline agents after 5 min
   - Always implement heartbeat loop in agent code

2. **Dual Redis Connections**: Pub/sub requires separate subscriber connection
   - One connection for commands, one for listening
   - If using one connection, pub/sub won't work
   - ioredis handles this automatically

3. **SQLite Polling**: Pub/sub simulated via 500ms polling
   - Use Redis for production (true pub/sub)
   - SQLite fine for development/testing
   - Set `SQLITE_POLL_INTERVAL` to adjust latency (lower = faster but higher CPU)

4. **Single Executable**: Can be packaged into standalone binary with pkg
   - Useful for distribution to non-technical users
   - Includes Node.js runtime, no external deps needed

5. **Thread Support**: Messages can be threaded via `replyTo` field
   - Great for code review feedback, discussion threads
   - Dashboard groups threaded messages together

6. **Artifact Deduplication**: Same path auto-updates existing artifact
   - `artifact_register({ path: "src/UserProfile.tsx", version: "2.0" })`
   - Updates if already exists, creates if new
   - Version field tracks iterations

7. **Real-time Events**: All actions publish events for dashboard updates
   - Dashboard subscribes to: `events:agent`, `events:message`, `events:task`, `events:artifact`
   - Refresh rate: 10 seconds (or real-time if WebSocket connected)
