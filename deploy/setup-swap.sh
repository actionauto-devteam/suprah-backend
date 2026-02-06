#!/bin/bash

# Swap Setup Script for Low RAM VPS
# Adds 4GB of swap space to prevent OOM errors during builds

set -e

echo "📦 Setting up Swap Space..."

# Check if swapfile already exists
if [ -f /swapfile ]; then
    echo "⚠️ Swap file already exists."
else
    # Create a 4GB swap file
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    
    # Make persistent
    echo '/swapfile none swap sw 0 0' | tee -a /etc/fstab
    
    echo "✅ Swap file created and enabled (4GB)"
fi

# Optimization settings
sysctl vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf
echo "✅ Swappiness set to 10"

echo "🎉 Swap setup complete!"
free -h
