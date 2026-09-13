#!/bin/bash

# Script to update OpenRouter API key on Fly.io

echo "🔑 Updating OpenRouter API key on Fly.io..."
echo ""

# Check if API key is provided as argument
if [ -z "$1" ]; then
    echo "Please provide your OpenRouter API key as an argument:"
    echo "  ./update-api-key.sh YOUR_API_KEY_HERE"
    echo ""
    echo "Or enter it interactively (will be hidden):"
    read -s OPENROUTER_API_KEY
else
    OPENROUTER_API_KEY="$1"
fi

# Validate that we have a key
if [ -z "$OPENROUTER_API_KEY" ]; then
    echo "❌ Error: API key is required"
    exit 1
fi

# Check if flyctl is installed
if ! command -v flyctl &> /dev/null; then
    echo "❌ flyctl is not installed. Please install it first:"
    echo "   brew install flyctl (macOS)"
    exit 1
fi

# Check if logged in to Fly.io
if ! flyctl auth whoami &> /dev/null; then
    echo "🔐 Not logged in to Fly.io. Running login..."
    flyctl auth login
fi

# Update the secret
echo "📝 Setting OPENROUTER_API_KEY secret..."
flyctl secrets set OPENROUTER_API_KEY="$OPENROUTER_API_KEY"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ API key updated successfully!"
    echo ""
    echo "🔄 Restarting the app to apply changes..."
    flyctl restart
    
    echo ""
    echo "✅ Done! The API key has been updated and the app restarted."
    echo "🌐 Test it at: http://127.0.0.1:18003/health"
else
    echo "❌ Failed to update API key"
    exit 1
fi

