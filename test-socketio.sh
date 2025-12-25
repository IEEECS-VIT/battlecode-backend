#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================="
echo "Socket.IO Connection Test"
echo "======================================="
echo ""

# Get the host from argument or default to localhost
HOST=${1:-localhost}
PORT=${2:-8000}

echo "Testing: http://$HOST:$PORT"
echo ""

# Test 1: Basic connectivity
echo -e "${YELLOW}[1/5] Testing basic server connectivity...${NC}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://$HOST:$PORT/)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Server is reachable (HTTP $HTTP_CODE)${NC}"
else
    echo -e "${RED}✗ Server not reachable (HTTP $HTTP_CODE)${NC}"
    exit 1
fi
echo ""

# Test 2: Socket.IO health endpoint
echo -e "${YELLOW}[2/5] Testing Socket.IO health endpoint...${NC}"
HEALTH=$(curl -s http://$HOST:$PORT/socket.io/health)
if echo "$HEALTH" | grep -q "ok"; then
    echo -e "${GREEN}✓ Socket.IO health endpoint OK${NC}"
    echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
else
    echo -e "${RED}✗ Socket.IO health endpoint failed${NC}"
    echo "$HEALTH"
fi
echo ""

# Test 3: Socket.IO handshake
echo -e "${YELLOW}[3/5] Testing Socket.IO handshake (without auth)...${NC}"
RESPONSE=$(curl -s "http://$HOST:$PORT/socket.io/?EIO=4&transport=polling")
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://$HOST:$PORT/socket.io/?EIO=4&transport=polling")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $RESPONSE"

if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    echo -e "${GREEN}✓ Socket.IO endpoint exists (auth required - this is expected)${NC}"
elif [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Socket.IO endpoint works!${NC}"
elif [ "$HTTP_CODE" = "404" ]; then
    echo -e "${RED}✗ Socket.IO endpoint returns 404 - THIS IS THE PROBLEM!${NC}"
    echo ""
    echo "Possible causes:"
    echo "  1. Server not binding to 0.0.0.0 (check server logs)"
    echo "  2. Docker port mapping issue"
    echo "  3. Socket.IO not properly initialized"
else
    echo -e "${YELLOW}⚠ Unexpected status: $HTTP_CODE${NC}"
fi
echo ""

# Test 4: Check if running in Docker
echo -e "${YELLOW}[4/5] Checking Docker status...${NC}"
if command -v docker &> /dev/null; then
    CONTAINER=$(docker ps --filter "publish=8000" --format "{{.Names}}" | head -n 1)
    if [ -n "$CONTAINER" ]; then
        echo -e "${GREEN}✓ Found container: $CONTAINER${NC}"
        echo ""
        echo "Container logs (last 10 lines):"
        docker logs --tail 10 "$CONTAINER" 2>&1 | grep -E "(Server running|Socket|Error|0.0.0.0)" || echo "No relevant logs found"
    else
        echo -e "${YELLOW}⚠ No container found on port 8000${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Docker not available${NC}"
fi
echo ""

# Test 5: Check listening ports
echo -e "${YELLOW}[5/5] Checking port binding...${NC}"
if command -v ss &> /dev/null; then
    BINDING=$(ss -tuln | grep ":$PORT " | head -n 1)
    if echo "$BINDING" | grep -q "0.0.0.0:$PORT"; then
        echo -e "${GREEN}✓ Server bound to 0.0.0.0:$PORT (correct)${NC}"
    elif echo "$BINDING" | grep -q "127.0.0.1:$PORT"; then
        echo -e "${RED}✗ Server bound to 127.0.0.1:$PORT (wrong - should be 0.0.0.0)${NC}"
        echo "This is likely the cause of your issue!"
    elif [ -n "$BINDING" ]; then
        echo "Server binding: $BINDING"
    else
        echo -e "${YELLOW}⚠ Could not detect port binding${NC}"
    fi
elif command -v netstat &> /dev/null; then
    BINDING=$(netstat -tuln | grep ":$PORT " | head -n 1)
    if echo "$BINDING" | grep -q "0.0.0.0:$PORT"; then
        echo -e "${GREEN}✓ Server bound to 0.0.0.0:$PORT (correct)${NC}"
    elif echo "$BINDING" | grep -q "127.0.0.1:$PORT"; then
        echo -e "${RED}✗ Server bound to 127.0.0.1:$PORT (wrong - should be 0.0.0.0)${NC}"
        echo "This is likely the cause of your issue!"
    else
        echo "Server binding: $BINDING"
    fi
else
    echo -e "${YELLOW}⚠ netstat/ss not available${NC}"
fi
echo ""

echo "======================================="
echo "Test Complete!"
echo ""
echo "Usage: $0 [host] [port]"
echo "Example: $0 localhost 8000"
echo "Example: $0 192.168.1.100 8000"
echo "======================================="
