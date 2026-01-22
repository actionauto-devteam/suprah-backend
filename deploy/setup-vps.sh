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
echo -e "${YELLOW}🔥 Step 2: Configuring Firewall...${NC}"
# Install and configure UFW firewall
apt-get install -y ufw

# Allow SSH (important!)
ufw allow 22/tcp

# Allow FTP ports
ufw allow 21/tcp
ufw allow 21000:21010/tcp

# Enable firewall
echo "y" | ufw enable

echo -e "${GREEN}✅ Firewall configured${NC}"

echo ""
echo -e "${YELLOW}📁 Step 3: Creating application directory...${NC}"
mkdir -p /opt/actionauto-ftp
cd /opt/actionauto-ftp

echo -e "${GREEN}✅ Directory created: /opt/actionauto-ftp${NC}"

echo ""
echo -e "${YELLOW}📝 Step 4: Setup Instructions${NC}"
echo ""
echo "Next steps to complete manually:"
echo ""
echo "1. Upload your code to /opt/actionauto-ftp:"
echo "   - Use SCP, Git, or SFTP to transfer files"
echo "   - Example: scp -r ActionAutoBackend/* root@198.251.79.28:/opt/actionauto-ftp/"
echo ""
echo "2. Create .env file in /opt/actionauto-ftp/deploy/"
echo "   - Copy from deploy/.env.vps.example"
echo "   - Update MONGODB_URI with your connection string"
echo "   - Set a strong FTP_SERVER_PASSWORD"
echo ""
echo "3. Build and start the FTP server:"
echo "   cd /opt/actionauto-ftp/deploy"
echo "   docker compose -f docker-compose.ftp.yml up -d --build"
echo ""
echo "4. Check logs:"
echo "   docker logs actionauto-ftp -f"
echo ""
echo -e "${GREEN}✅ VPS setup complete!${NC}"
echo ""
echo "Your FTP server will be accessible at: ftp://198.251.79.28"
