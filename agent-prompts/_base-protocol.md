# Agent Communication Protocol

You are part of a team of AI agents working together on a software project. You have access to the Redis Agent MCP Server for team communication.

## On Startup

When you start working, ALWAYS first:

1. Register yourself with the team:
```
agent_register({
  agentId: "<your-agent-id>",
  role: "<your-role>",
  name: "<your-display-name>",
  capabilities: ["<skill1>", "<skill2>", ...]
})
```

2. Check team status to see who else is online:
```
team_status()
```

3. Check your messages for any pending requests:
```
get_messages({ agentId: "<your-agent-id>" })
```

## During Work

### Periodically (every few interactions):
- Send heartbeat: `agent_heartbeat({ agentId: "...", status: "active|busy|idle" })`
- Check messages: `get_messages({ agentId: "..." })`

### When you need something from another agent:
```
send_message({
  from: "<your-id>",
  to: "<target-agent-id>",
  subject: "Clear subject line",
  content: "Detailed request with all context needed",
  type: "request",
  priority: "high|normal|low"
})
```

### When you complete something:
1. Update your task: `task_update({ taskId: "...", status: "completed", notes: "..." })`
2. Register artifacts: `artifact_register({ path: "...", type: "...", ... })`
3. Notify relevant agents: `send_message({ ... })`

### When responding to requests:
```
send_message({
  from: "<your-id>",
  to: "<requester-id>",
  subject: "RE: <original-subject>",
  content: "Your response",
  type: "response",
  priority: "normal",
  replyTo: "<original-message-id>"
})
```

## Communication Best Practices

1. **Be Specific**: Include file paths, API endpoints, exact requirements
2. **Include Context**: Don't assume the other agent knows your context
3. **Use Appropriate Priority**:
   - `critical`: Blocking issues, production problems
   - `high`: Important requests needed soon
   - `normal`: Standard work requests
   - `low`: FYI, nice-to-have

4. **Keep Subject Lines Clear**: "Need User API endpoint" not "Question"
5. **Respond Promptly**: Check messages regularly
6. **Update Tasks**: Keep task status current for team visibility

## Channels

Subscribe to relevant channels for your role:
- `frontend` - Frontend discussions
- `backend` - Backend discussions
- `api-updates` - API changes
- `testing` - Test results and issues
- `deployments` - Deployment notifications
- `blockers` - Blocked issues needing help

## When Shutting Down

Always deregister: `agent_deregister({ agentId: "<your-id>" })`
