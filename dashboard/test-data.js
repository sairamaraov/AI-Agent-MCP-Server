// Test script to populate Redis with sample data for dashboard testing
// Run with: node test-data.js

import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  keyPrefix: "agent-team:",
});

async function populateTestData() {
  console.log("Populating test data...\n");

  // Sample agents
  const agents = [
    { id: "lead-agent", role: "team-lead", name: "Team Lead", capabilities: ["architecture", "planning"], status: "active" },
    { id: "frontend-1", role: "frontend-engineer", name: "Frontend Dev 1", capabilities: ["react", "typescript"], status: "busy" },
    { id: "frontend-2", role: "frontend-engineer", name: "Frontend Dev 2", capabilities: ["nextjs", "tailwind"], status: "active" },
    { id: "backend-1", role: "backend-engineer", name: "Backend Dev 1", capabilities: ["nodejs", "postgresql"], status: "active" },
    { id: "backend-2", role: "backend-engineer", name: "Backend Dev 2", capabilities: ["python", "redis"], status: "idle" },
    { id: "tester-1", role: "qa-engineer", name: "QA Engineer", capabilities: ["playwright", "jest"], status: "active" },
    { id: "devops-1", role: "devops-engineer", name: "DevOps Engineer", capabilities: ["docker", "kubernetes"], status: "busy" },
  ];

  const now = Date.now();

  // Register agents
  for (const agent of agents) {
    const agentData = {
      ...agent,
      lastSeen: now,
      registeredAt: now - Math.random() * 86400000, // Random time in last 24h
    };

    await redis.hset("agents:registry", agent.id, JSON.stringify(agentData));
    
    // Set presence (with TTL)
    if (agent.status !== "offline") {
      await redis.setex(`agents:presence:${agent.id}`, 30, String(now));
    }
    
    console.log(`✓ Registered agent: ${agent.name}`);
  }

  // Sample tasks
  const tasks = [
    { title: "Implement User Authentication", description: "JWT-based auth with refresh tokens", priority: "critical", status: "in-progress", assignee: "backend-1", reporter: "lead-agent" },
    { title: "Build Dashboard UI", description: "Create responsive dashboard with charts", priority: "high", status: "in-progress", assignee: "frontend-1", reporter: "lead-agent" },
    { title: "Write Integration Tests", description: "E2E tests for user flow", priority: "normal", status: "pending", assignee: "tester-1", reporter: "lead-agent" },
    { title: "Setup CI/CD Pipeline", description: "GitHub Actions workflow", priority: "high", status: "review", assignee: "devops-1", reporter: "lead-agent" },
    { title: "API Documentation", description: "OpenAPI spec for all endpoints", priority: "normal", status: "pending", reporter: "lead-agent" },
    { title: "Database Schema Migration", description: "Add new columns for v2", priority: "high", status: "blocked", assignee: "backend-2", reporter: "backend-1" },
    { title: "Performance Optimization", description: "Optimize database queries", priority: "normal", status: "completed", assignee: "backend-1", reporter: "lead-agent" },
    { title: "Mobile Responsive Design", description: "Fix layout issues on mobile", priority: "normal", status: "in-progress", assignee: "frontend-2", reporter: "frontend-1" },
  ];

  for (const task of tasks) {
    const taskId = uuidv4();
    const taskData = {
      id: taskId,
      ...task,
      dependencies: [],
      blockedBy: task.status === "blocked" ? ["some-blocker"] : [],
      artifacts: [],
      notes: [],
      createdAt: now - Math.random() * 172800000, // Random time in last 48h
      updatedAt: now - Math.random() * 86400000,
    };

    await redis.set(`tasks:${taskId}`, JSON.stringify(taskData));
    await redis.sadd("tasks:all", taskId);
    await redis.sadd(`tasks:by-status:${task.status}`, taskId);
    
    if (task.assignee) {
      await redis.sadd(`tasks:by-agent:${task.assignee}`, taskId);
    }

    // Add some history
    const history = [
      { taskId, agentId: task.reporter, action: "created", details: "Task created", timestamp: taskData.createdAt },
    ];
    
    if (task.assignee) {
      history.push({ taskId, agentId: task.reporter, action: "assigned", details: `Assigned to ${task.assignee}`, timestamp: taskData.createdAt + 1000 });
    }
    
    if (task.status === "in-progress" || task.status === "review" || task.status === "completed") {
      history.push({ taskId, agentId: task.assignee || task.reporter, action: "status_changed", details: "Started working", timestamp: taskData.updatedAt });
    }

    for (const event of history) {
      await redis.lpush(`tasks:${taskId}:history`, JSON.stringify(event));
    }

    console.log(`✓ Created task: ${task.title}`);
  }

  // Sample messages
  const messages = [
    { from: "lead-agent", to: "frontend-1", type: "request", subject: "Dashboard Priority", content: "Please prioritize the dashboard UI, client demo tomorrow.", priority: "high" },
    { from: "frontend-1", to: "backend-1", type: "request", subject: "Need User API", content: "I need the GET /api/users/{id} endpoint for the profile page.", priority: "high" },
    { from: "backend-1", to: "frontend-1", type: "response", subject: "RE: Need User API", content: "API is ready. Check /docs/api/users.yaml for the spec.", priority: "normal" },
    { from: "tester-1", to: "frontend-1", type: "notification", subject: "Bug Found: Login", content: "Login button doesn't work on Safari. Please check.", priority: "high" },
    { from: "devops-1", to: "lead-agent", type: "notification", subject: "Deployment Complete", content: "v1.2.0 deployed to staging environment.", priority: "normal" },
    { from: "backend-2", to: "backend-1", type: "request", subject: "Help with Migration", content: "Can you review my migration script? I'm stuck on the enum types.", priority: "normal" },
  ];

  for (const msg of messages) {
    const message = {
      id: uuidv4(),
      ...msg,
      timestamp: now - Math.random() * 3600000, // Random time in last hour
      read: Math.random() > 0.5,
    };

    await redis.lpush(`messages:inbox:${msg.to}`, JSON.stringify(message));
    console.log(`✓ Created message: ${msg.subject}`);
  }

  // Sample artifacts with content
  const artifacts = [
    {
      path: "/docs/api/users.yaml",
      type: "api-spec",
      owner: "backend-1",
      description: "User API specification",
      content: `openapi: 3.0.0
info:
  title: User API
  version: 1.0.0
paths:
  /api/users:
    get:
      summary: Get all users
      responses:
        '200':
          description: List of users
    post:
      summary: Create new user
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                email:
                  type: string
                name:
                  type: string
  /api/users/{id}:
    get:
      summary: Get user by ID
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string`
    },
    {
      path: "/src/components/Dashboard.tsx",
      type: "component",
      owner: "frontend-1",
      description: "Main dashboard component",
      content: `import React, { useState, useEffect } from 'react';
import { fetchDashboardData } from '../api';
import Card from './Card';
import Chart from './Chart';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData().then(result => {
      setData(result);
      setLoading(false);
    });
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="dashboard">
      <h1>Analytics Dashboard</h1>
      <div className="grid">
        <Card title="Total Users" value={data.totalUsers} />
        <Card title="Active Orders" value={data.activeOrders} />
        <Card title="Revenue" value={data.revenue} />
      </div>
      <Chart data={data.chartData} />
    </div>
  );
}`
    },
    {
      path: "/tests/e2e/login.spec.ts",
      type: "test",
      owner: "tester-1",
      description: "Login flow E2E tests",
      content: `import { test, expect } from '@playwright/test';

test.describe('Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('should login with valid credentials', async ({ page }) => {
    await page.fill('input[name="email"]', 'test@example.com');
    await page.fill('input[name="password"]', 'password123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('/dashboard');
    await expect(page.locator('h1')).toContainText('Dashboard');
  });

  test('should show error with invalid password', async ({ page }) => {
    await page.fill('input[name="email"]', 'test@example.com');
    await page.fill('input[name="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    await expect(page.locator('[role="alert"]')).toContainText('Invalid credentials');
  });
});`
    },
    {
      path: "/.github/workflows/deploy.yml",
      type: "config",
      owner: "devops-1",
      description: "CI/CD deployment workflow",
      content: `name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to production
        run: |
          npm run build
          npm run deploy --env production
        env:
          DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}`
    },
  ];

  for (const artifact of artifacts) {
    const artifactId = uuidv4();
    const artifactData = {
      id: artifactId,
      ...artifact,
      version: "1.0.0",
      size: artifact.content ? artifact.content.length : 0,
      tags: ["production", "shared"],
      createdAt: now - Math.random() * 86400000,
      updatedAt: now - Math.random() * 3600000,
    };

    await redis.set(`artifacts:${artifactId}`, JSON.stringify(artifactData));
    await redis.sadd("artifacts:all", artifactId);
    console.log(`✓ Created artifact: ${artifact.path} (${artifactData.size} bytes)`);
  }

  console.log("\n✅ Test data populated successfully!");
  console.log("\nStart the dashboard with: npm start (in dashboard folder)");
  console.log("Then open: http://localhost:3456\n");

  await redis.quit();
}

populateTestData().catch(console.error);
