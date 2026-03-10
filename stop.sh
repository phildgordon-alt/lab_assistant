#!/bin/bash
pkill -f "node.*oven-timer-server" 2>/dev/null && echo "Lab Server stopped" || echo "Lab Server not running"
pkill -f "tsx.*index.ts" 2>/dev/null && echo "Gateway stopped" || echo "Gateway not running"
pkill -f "vite.*--host" 2>/dev/null && echo "Frontend stopped" || echo "Frontend not running"
