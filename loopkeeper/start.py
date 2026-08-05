#!/usr/bin/env python3
"""
Simple startup script for Savar AI backend
Ensures proper module loading
"""

import os
import sys
import uvicorn

# Ensure we're using the correct directory
backend_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(backend_dir)

# Add current directory to Python path (at the beginning)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

# Remove any other hanu directories from path to avoid conflicts
sys.path = [p for p in sys.path if 'goop' not in p]

# Now import and run
if __name__ == "__main__":
    port = int(os.getenv("PORT", 8003))
    print(f"Starting Savar AI backend on port {port}")
    print(f"Working directory: {os.getcwd()}")
    print(f"Python path: {sys.path[:3]}...")  # Show first 3 paths
    
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)