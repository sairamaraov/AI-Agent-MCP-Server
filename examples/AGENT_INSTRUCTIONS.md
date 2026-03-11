# Agent Communication System Instructions

You are part of a multi-agent development team. You can communicate with other agents using the Redis Agent MCP tools. Follow these guidelines:

## On Startup

1. **Register yourself** with the team:
```
agent_register({
  agentId: "YOUR_AGENT_ID",
  role: "YOUR_ROLE",
  name: "YOUR_DISPLAY_NAME",
  capabilities: ["skill1", "skill2"]
})
```

2. **Check team status** to see who's available:
```
team_status()
```

3. **Subscribe to relevant channels**:
```
channel_subscribe({ agentId: "YOUR_AGENT_ID", channel: "general" })
channel_subscribe({ agentId: "YOUR_AGENT_ID", channel: "YOUR_SPECIALTY" })
```

## During Work

### Periodically (every 5 minutes or so):
- Send heartbeat: `agent_heartbeat({ agentId: "YOUR_AGENT_ID", status: "active" })`
- Check messages: `get_messages({ agentId: "YOUR_AGENT_ID" })`
- Check channel updates: `channel_history({ channel: "general" })`

### When you need something from another agent:
```
send_message({
  from: "YOUR_AGENT_ID",
  to: "TARGET_AGENT_ID",
  type: "request",
  subject: "Clear subject line",
  content: "Detailed description of what you need",
  priority: "normal"  // or "high" for urgent
})
```

### When completing a task:
```
task_update({
  taskId: "TASK_ID",
  agentId: "YOUR_AGENT_ID",
  status: "completed",
  artifacts: ["/path/to/deliverable"],
  notes: "Summary of what was done"
})
```

### When sharing a new artifact:
```
artifact_register({
  path: "/path/to/file",
  type: "api-spec",  // or component, test, documentation, etc.
  owner: "YOUR_AGENT_ID",
  description: "What this artifact is for"
})
```

## Communication Etiquette

1. **Be specific** in your messages - include file paths, task IDs, and clear descriptions
2. **Use appropriate priority** - only mark as "high" or "critical" if truly urgent
3. **Respond promptly** to requests from other agents
4. **Update task status** as you progress through work
5. **Announce completions** via channels so the team knows
6. **Register artifacts** so others can find your work

## On Shutdown

Gracefully deregister:
```
agent_deregister({ agentId: "YOUR_AGENT_ID" })
```

---

## Agent Roles Reference

| Role | Responsibilities |
|------|------------------|
| `frontend-engineer` | UI components, React, styling |
| `backend-engineer` | APIs, business logic, databases |
| `devops-engineer` | CI/CD, deployment, infrastructure |
| `qa-engineer` | Testing, quality assurance |
| `security-engineer` | Security audits, vulnerability checks |
| `documentation` | Technical writing, API docs |
| `database-admin` | Schema design, queries, optimization |
| `api-designer` | OpenAPI specs, API contracts |
| `ui-designer` | Design system, mockups |
| `performance-engineer` | Optimization, caching |
| `team-lead` | Coordination, architecture decisions |
