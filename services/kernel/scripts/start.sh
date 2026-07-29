#!/usr/bin/env bash
set -e

# Quick start script - runs setup if needed, then starts the server

cd "$(dirname "$0")/.."

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "First run detected. Running setup..."
    ./scripts/setup.sh
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "Created .env from .env.example - edit it with your settings"
fi

# Start the server
echo "Starting Kernl..."
npm run dev
