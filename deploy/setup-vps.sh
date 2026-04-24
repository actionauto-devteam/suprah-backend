#!/bin/bash

# ActionAuto FTP Server - VPS Setup Script
# This script automates the deployment of the FTP server on Ubuntu/Debian VPS

set -e  # Exit on error

echo "🚀 ActionAuto FTP Server - VPS Setup"
echo "======================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Please run as root (use: sudo bash setup-vps.sh)${NC}"
    exit 1
fi

echo -e "${YELLOW}📦 Step 1: Installing Docker...${NC}"
# Install Docker if not already installed
if ! command -v docker &> /dev/null; then
    apt-get update
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    
    echo \
      "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    echo -e "${GREEN}✅ Docker installed${NC}"
else
    echo -e "${GREEN}✅ Docker already installed${NC}"
fi

echo ""
echo -e "${YELLOW}📦 Step 1.5: Setup Swap Memory...${NC}"
if [ -f /swapfile ]; then
    echo -e "${GREEN}✅ Swap file already exists${NC}"
else
    # Create a 4GB swap file (essential for low-RAM instances during builds/syncs)
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' | tee -a /etc/fstab
    sysctl vm.swappiness=10
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
    echo -e "${GREEN}✅ 4GB Swap file created and enabled${NC}"
fi

echo ""
echo -e "${YELLOW}🔥 Step 2: Configuring Firewall...${NC}"
# Install and configure UFW firewall
apt-get install -y ufw

# Allow SSH (important!)
ufw allow 22/tcp

# Allow FTP ports
ufw allow 21/tcp
ufw allow 21000:21010/tcp

# Allow HTTP/HTTPS ports (Crucial for Nginx & SSL)
ufw allow 80/tcp
ufw allow 443/tcp

# Enable firewall
echo "y" | ufw enable

echo -e "${GREEN}✅ Firewall configured${NC}"

echo ""
echo -e "${YELLOW}📁 Step 3: Configuring Application Environment...${NC}"
mkdir -p /opt/actionauto/deploy/nginx/conf.d
mkdir -p /opt/actionauto/deploy/certbot/conf
mkdir -p /opt/actionauto/deploy/certbot/www
cd /opt/actionauto/deploy

echo -e "${GREEN}✅ Infrastructure ready in: /opt/actionauto${NC}"

echo ""
echo -e "${YELLOW}📝 Step 4: Final Production Checklist${NC}"
echo ""
echo "1. Upload your Secrets:"
echo "   - Create /opt/actionauto/.env (Use deploy/.env.vps.example as a template)"
echo "   - Ensure MONGODB_URI and REDIS_PASSWORD are set."
echo ""
echo "2. Bootstrapping the Services:"
echo "   - Copy docker-compose.prod.yml to /opt/actionauto/deploy/"
echo "   - Run: docker compose -f docker-compose.prod.yml up -d"
echo ""
echo "3. SSL Initialization:"
echo "   - Run the init-letsencrypt.sh script in the deploy folder to get your certs."
echo ""
echo "4. CI/CD Linkage:"
echo "   - Ensure your VPS_HOST, VPS_SSH_USER, and VPS_SSH_PASSWORD secrets are in GitHub."
echo ""
echo -e "${GREEN}✅ VPS Security & Runtime setup complete!${NC}"
echo ""
