# Agent Team MCP Server

A Model Context Protocol (MCP) server that enables real-time communication between multiple AI agents. Designed for orchestrating teams of specialized AI agents (frontend, backend, tester, DevOps, etc.) working on shared projects.

Uses **Redis** for data storage and pub/sub messaging, enabling multi-instance deployments with real-time capabilities.

Includes a **real-time web dashboard** for full transparency into agent communications, workloads, tasks, and shared artifacts.

## Core Features

- **Agent Management**: Register agents, track presence via heartbeats, see team status
- **Direct Messaging**: Send messages between agents with priority and threading
- **Channel Communication**: Pub/sub channels for topic-based communication
- **Task Management**: Create, assign, and track tasks across the team
- **Artifact Sharing**: Register and share artifacts (API specs, components, docs)
- **Real-time Updates**: Redis pub/sub for instant notifications

## Dashboard Features ✨

### 🎯 Team Overview
- **Agent Status**: Real-time status of all team members (active, busy, idle, offline)
- **Presence Tracking**: Heartbeat-based agent availability
- **Team Statistics**: Total agents, breakdown by status

### 📊 Transparency & Monitoring
- **Communication Graph**: Visualize who communicates with whom, sorted by message frequency
- **Agent Workload**: Per-agent task breakdown (pending → in-progress → review → blocked → completed)
- **Unread Messages**: Track message queue for each agent
- **Message Threads**: Thread-based message conversations with request-response tracking
- **Task Board**: Kanban-style task visualization across all status states

### 📁 Artifact Management
- **Artifact Grid**: Browse all shared artifacts with owner and type information
- **Artifact Modal**: Click to view full artifact contents with:
  - File metadata (owner, version, creation/update dates)
  - Full scrollable content (syntax-highlighted code, configs)
  - File size and tags
  - Metadata and additional info
- **Real-time Sync**: Auto-updates as new artifacts are shared

### 💬 Message Management
- **Recent Messages**: Latest 20 messages with sender/recipient info
- **Message Modal**: Click any message to view full details:
  - Message metadata (from, to, timestamp, type)
  - Complete subject and content
  - Optional metadata fields
- **Message Types**: Request, Response, Notification, Direct
- **Thread Detection**: Automatically groups RE: messages into conversation threads

### 📈 Activity Feed
- **Unified Activity Log**: All team activities in chronological order
- **Activity Types**: Task updates, messages, artifacts, agent events
- **Real-time Updates**: Live feed of team progress

## Prerequisites

- **Node.js 18+** — required to build and run the MCP server
- **Redis** — for agent state and messaging (see setup options below)

## Quick Start

### Step 1 — Build the MCP server

```bash
git clone https://github.com/your-username/ClaudeAgentMCPServer
cd ClaudeAgentMCPServer
npm install
npm run build
```

### Step 2 — Start Redis + Dashboard

**Option A: Docker (recommended)**
```bash
docker compose up -d
# → Redis at localhost:6379
# → Dashboard at http://localhost:3456
```

**Option B: Without Docker**
```bash
# Install Redis manually:
#   macOS:   brew install redis && brew services start redis
#   Ubuntu:  sudo apt install redis-server && sudo systemctl start redis
#   Windows: https://github.com/microsoftarchive/redis/releases

# Start the dashboard separately
cd dashboard
npm install
npm start
# → Dashboard at http://localhost:3456
```

Then wire Claude to the MCP server (see [Connecting Claude](#connecting-claude) below).

> **Why is the MCP server not in Docker?**
> The MCP server communicates over **stdio** — Claude launches it directly as a child process. It is not an HTTP service and cannot be reached via a network port. Docker handles Redis (shared state) and the dashboard (monitoring UI) only.

## Connecting Claude

### Option A — Claude Code (automatic, project-level)

A `.mcp.json` is included in this repo. When you open this folder in Claude Code it will prompt you to enable the `agent-team` MCP server automatically. Redis must be running first (`docker compose up -d`).

### Option B — Claude Desktop (manual, global)

Edit your Claude Desktop config file:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add this block (replace the path with your actual clone location):

```json
{
  "mcpServers": {
    "agent-team": {
      "command": "node",
      "args": ["/absolute/path/to/ClaudeAgentMCPServer/dist/index.js"],
      "env": {
        "REDIS_HOST": "localhost",
        "REDIS_PORT": "6379"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `localhost` | Redis server host |
| `REDIS_PORT` | `6379` | Redis server port |
| `REDIS_PASSWORD` | (none) | Redis password if required |
| `REDIS_DB` | `0` | Redis database number |
| `REDIS_PREFIX` | `agent-team:` | Key prefix for all Redis keys |
| `DASHBOARD_PORT` | `3456` | Web dashboard port |

## Tools Available

### Agent Management
- `agent_register` - Register an agent with the team
- `agent_heartbeat` - Send heartbeat to maintain presence
- `agent_deregister` - Leave the team
- `team_status` - Get status of all team members
- `agent_status` - Get detailed status of specific agent
- `list_agents` - List all agents with optional filters

### Messaging
- `send_message` - Send direct message to another agent
- `get_messages` - Get inbox or sent messages
- `broadcast_message` - Broadcast to all agents or a role group
- `get_unread_count` - Get unread message count

### Channels
- `channel_subscribe` - Subscribe to a topic channel
- `channel_unsubscribe` - Unsubscribe from a channel
- `channel_publish` - Publish message to a channel
- `channel_history` - Get recent channel messages
- `list_channels` - List all available channels

### Tasks
- `task_create` - Create a new task
- `task_update` - Update task status, assignee, add notes
- `task_get` - Get task details
- `task_list` - List tasks with filters
- `task_history` - Get task event history

### Artifacts
- `artifact_register` - Register a shared artifact
- `artifact_list` - List artifacts with filters
- `artifact_get` - Get artifact details
- `artifact_notify` - Notify agents about artifact changes
- `artifact_search` - Search artifacts by path pattern

## Dashboard REST API

The dashboard server exposes the following REST endpoints:

### Team & Agents
- `GET /api/team-status` - Get all agents and their current status

### Tasks
- `GET /api/tasks` - Get all tasks with summary by status

### Messages
- `GET /api/messages/recent` - Get 50 most recent messages

### Communication
- `GET /api/communication-graph` - Get communication patterns (who talks to whom)
- `GET /api/agent-workload` - Get per-agent workload and task breakdown
- `GET /api/message-chains` - Get threaded message conversations

### Artifacts
- `GET /api/artifacts` - Get all shared artifacts with full content

### Activity
- `GET /api/activity` - Get activity feed with all team events

## WebSocket Real-time Updates

Dashboard connects to server via WebSocket (`ws://localhost:3456`) for real-time updates:

- Initial data push on connection
- Live updates on agent status changes
- Broadcast events for team-wide notifications
- 10-second automatic refresh cycle for all transparency data

## Example Workflow

### 1. Agent Registration (Each agent on startup)
```
agent_register({
  agentId: "frontend-1",
  role: "frontend-engineer",
  name: "Frontend Agent 1",
  capabilities: ["react", "typescript", "tailwind"]
})
```

### 2. Check Team Status
```
team_status()
```

### 3. Send Request to Backend
```
send_message({
  from: "frontend-1",
  to: "backend-1",
  type: "request",
  subject: "Need User API",
  content: "Please create GET /api/users/{id} endpoint. Need: id, name, email, avatar",
  priority: "high"
})
```

### 4. Create Task
```
task_create({
  title: "Implement User Profile API",
  description: "Create REST endpoint for user profile data",
  priority: "high",
  assignee: "backend-1",
  reporter: "frontend-1"
})
```

### 5. Publish to Channel
```
channel_publish({
  agentId: "backend-1",
  channel: "api-updates",
  content: "User API v1.0 deployed. GET /api/users/{id} now available."
})
```

### 6. Monitor on Dashboard
Open http://localhost:3456 in your browser to see:
- ✅ **Team Status**: All agents and their current status (active, busy, idle, offline)
- 🔗 **Communication Graph**: Visual representation of message flow between agents
- 📊 **Agent Workload**: Tasks breakdown for each agent (pending, in-progress, review, blocked, completed)
- 📁 **Shared Artifacts**: Browse and click artifacts to view full content (API specs, code, configs)
- 💬 **Messages**: Recent messages - click any message to view full details in modal
- 🔀 **Message Threads**: Conversation threads with RE: (response) tracking
- 📈 **Activity Feed**: Chronological log of all team activities
- ✅ **Task Board**: Kanban board view of all tasks by status

All dashboard sections update in real-time as agents communicate and work progresses.

## Dashboard Interactive Features

### Message Modal
Click any message in "Recent Messages" to open a detailed modal showing:
- Message type (request, response, notification, direct)
- From/To agents and timestamp
- Full subject and content
- Optional metadata fields

### Artifact Modal
Click any artifact card in "Shared Artifacts" to open a detailed modal showing:
- Full file path and owner information
- File metadata (version, creation date, size)
- Complete scrollable file content (with syntax preservation)
- Tags and additional metadata
- File size calculation (Bytes → KB → MB → GB)

### Close Interactions
- Click the ✕ button to close any modal
- Click outside the modal (overlay) to close
- Press ESC key to close

## Agent Roles

| Agent ID | Role | Responsibilities |
|----------|------|------------------|
| lead-agent | Team Lead | Task coordination, architecture |
| frontend-1, frontend-2 | Frontend Engineer | React/Next.js, UI/UX |
| backend-1, backend-2 | Backend Engineer | API, business logic |
| devops-1 | DevOps Engineer | CI/CD, deployment |
| tester-1, tester-2 | QA Engineer | Testing |
| security-1 | Security Engineer | Security audits |
| docs-1 | Documentation | API docs, guides |
| db-1 | Database Admin | Schema, optimization |
| api-1 | API Designer | OpenAPI specs |
| ui-1 | UI/UX Designer | Design system |
| perf-1 | Performance Engineer | Optimization |
| infra-1 | Infrastructure | AWS, scaling |

## Development

```bash
# Run in development mode
npm run dev

# Build
npm run build

# Start built version
npm start
```

## Troubleshooting

### Dashboard shows "No agents yet"
- Ensure MCP server is running and agents have registered
- Run `node dashboard/test-data.js` to populate test data
- Check Redis connection: `redis-cli ping` should return `PONG`

### Redis WRONGTYPE Error
- This can occur if keys are stored as different data types
- Solution implemented in code: type checking before reads with `redis.type()`
- Data is now read as string, list, or hash as needed

### Messages/Artifacts not appearing
- Check that Redis is running and accessible
- Verify `REDIS_HOST` and `REDIS_PORT` match in MCP server and dashboard
- Dashboard refreshes every 10 seconds; wait a moment for updates

### Dashboard not connecting to WebSocket
- Ensure dashboard server is running on port 3456
- Check browser console for WebSocket errors
- Try refreshing the page

### Port already in use
- MCP Server: Runs on port 7777 (internal, no external access)
- Dashboard: `DASHBOARD_PORT=3457 npm start` to use different port
- Check with `lsof -i :3456` (macOS/Linux) or `netstat -an | findstr :3456` (Windows)

## Architecture

### Components
1. **MCP Server** (`src/index.ts`): Handles agent communication, tasks, artifacts
2. **Dashboard Server** (`dashboard/server.js`): Express server + WebSocket for real-time updates
3. **Dashboard Frontend** (`dashboard/public/index.html`): Vue-like reactive UI
4. **Redis**: Shared data store for all components

### Data Flow
```
Agents (Claude Code clients)
    ↓
MCP Server ← → Redis ← → Dashboard Server ← WebSocket ← Dashboard UI
```

### Key Redis Structures
- `agents:registry` (hash): All registered agents
- `tasks:all` (set): Task IDs, `tasks:{id}` (string): Task data
- `messages:inbox:{agentId}` (list): Messages for agent
- `artifacts:all` (set): Artifact IDs, `artifacts:{id}` (string): Artifact data
- `{type}:channels:{name}` (list): Channel messages

## License

MIT
