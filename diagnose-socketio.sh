#!/bin/bash

echo "==================================="
echo "Socket.IO Diagnostic Script"
echo "==================================="
echo ""

# Test 1: Basic HTTP endpoint
echo "1. Testing basic HTTP endpoint..."
curl -s http://localhost:8000/ && echo "" || echo "FAILED: Basic HTTP endpoint not reachable"
echo ""

# Test 2: Socket.IO health check
echo "2. Testing Socket.IO health endpoint..."
curl -s http://localhost:8000/socket.io/health | python3 -m json.tool 2>/dev/null || echo "FAILED: Socket.IO health endpoint not reachable"
echo ""

# Test 3: Socket.IO polling endpoint
echo "3. Testing Socket.IO polling endpoint (EIO=4)..."
curl -v "http://localhost:8000/socket.io/?EIO=4&transport=polling" 2>&1 | grep -E "(< HTTP|sid|Session ID)"
echo ""

# Test 4: Check if server is listening on all interfaces
echo "4. Checking server listening addresses..."
if command -v netstat &> /dev/null; then
    netstat -tuln | grep :8000
elif command -v ss &> /dev/null; then
    ss -tuln | grep :8000
else
    echo "netstat/ss not available, skipping..."
fi
echo ""

# Test 5: Docker container check (if running in Docker)
echo "5. Docker container status..."
if command -v docker &> /dev/null; then
    docker ps | grep battlecode || echo "No battlecode container running"
else
    echo "Docker not available"
fi
echo ""

# Test 6: Check Socket.IO version
echo "6. Socket.IO version in package.json..."
grep "socket.io" package.json
echo ""

echo "==================================="
echo "Diagnostic complete!"
echo "==================================="
