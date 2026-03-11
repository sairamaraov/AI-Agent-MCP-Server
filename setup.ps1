# Redis Agent MCP Server - Setup Script
# Run with: .\setup.ps1

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Redis Agent MCP Server Setup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
Write-Host "Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = node --version 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Node.js not found. Please install Node.js 18+" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js version: $nodeVersion" -ForegroundColor Green

# Check Redis
Write-Host ""
Write-Host "Checking Redis connection..." -ForegroundColor Yellow
$redisHost = if ($env:REDIS_HOST) { $env:REDIS_HOST } else { "localhost" }
$redisPort = if ($env:REDIS_PORT) { $env:REDIS_PORT } else { "6379" }

try {
    $tcpClient = New-Object System.Net.Sockets.TcpClient
    $tcpClient.Connect($redisHost, [int]$redisPort)
    $tcpClient.Close()
    Write-Host "Redis is running at ${redisHost}:${redisPort}" -ForegroundColor Green
} catch {
    Write-Host "WARNING: Cannot connect to Redis at ${redisHost}:${redisPort}" -ForegroundColor Yellow
    Write-Host "Make sure Redis is running before using the MCP server" -ForegroundColor Yellow
}

# Install MCP Server dependencies
Write-Host ""
Write-Host "Installing MCP Server dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to install MCP Server dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "MCP Server dependencies installed" -ForegroundColor Green

# Build MCP Server
Write-Host ""
Write-Host "Building MCP Server..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to build MCP Server" -ForegroundColor Red
    exit 1
}
Write-Host "MCP Server built successfully" -ForegroundColor Green

# Install Dashboard dependencies
Write-Host ""
Write-Host "Installing Dashboard dependencies..." -ForegroundColor Yellow
Push-Location dashboard
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to install Dashboard dependencies" -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "Dashboard dependencies installed" -ForegroundColor Green
Pop-Location

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Start the Dashboard:" -ForegroundColor White
Write-Host "   cd dashboard" -ForegroundColor Gray
Write-Host "   npm start" -ForegroundColor Gray
Write-Host "   Open http://localhost:3456" -ForegroundColor Gray
Write-Host ""
Write-Host "2. (Optional) Load test data:" -ForegroundColor White
Write-Host "   cd dashboard" -ForegroundColor Gray
Write-Host "   npm run test-data" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Add to Claude Code MCP config:" -ForegroundColor White
Write-Host '   {' -ForegroundColor Gray
Write-Host '     "mcpServers": {' -ForegroundColor Gray
Write-Host '       "redis-agent-mcp": {' -ForegroundColor Gray
Write-Host '         "command": "node",' -ForegroundColor Gray
Write-Host "         `"args`": [`"$($PWD -replace '\\', '\\\\')\dist\index.js`"]" -ForegroundColor Gray
Write-Host '       }' -ForegroundColor Gray
Write-Host '     }' -ForegroundColor Gray
Write-Host '   }' -ForegroundColor Gray
Write-Host ""
