# FTP Server Credentials

**⚠️ CONFIDENTIAL - DO NOT COMMIT TO GIT ⚠️**

## Production FTP Server Details

**Host:** `ftp://198.251.79.28`  
**Port:** `21`  
**Protocol:** FTP (plain, not FTPS/SFTP)  
**Username:** `actionauto`  
**Password:** `SV#1`%dUKQvSRefE`  
**Path:** `/`

---

## For DealersCloud Integration

Send them these exact details:

```
FTP Server Configuration:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Host:     ftp://198.251.79.28
Port:     21
Username: actionauto
Password: SV#1`%dUKQvSRefE
Protocol: FTP (plain - not FTPS or SFTP)
Path:     /
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

File Format: CSV
File Name:   Any filename ending in .csv
Upload Path: Root directory (/)
```

---

## Testing with FileZilla

1. Open FileZilla
2. Go to **File → Site Manager**
3. Click **New Site**
4. Configure:
   - **Protocol:** `FTP - File Transfer Protocol`
   - **Host:** `198.251.79.28`
   - **Port:** `21`
   - **Encryption:** `Only use plain FTP (insecure)` ← **IMPORTANT!**
   - **Logon Type:** `Normal`
   - **User:** `actionauto`
   - **Password:** `SV#1`%dUKQvSRefE`
5. Click **Connect**

---

## How It Works

1. **File Upload:** DealersCloud uploads a CSV file via FTP
2. **Auto-Detection:** File watcher detects any `.csv` file
3. **Processing:** Sync service processes the file and updates MongoDB
4. **Cleanup:** File is automatically deleted after processing
5. **Logging:** All activity is logged in Docker container

---

## Monitoring

<!-- Access the env -->
nano deploy/.env

**View FTP server logs:**
```bash
ssh root@198.251.79.28
Tgm01OkJ
cd /opt/actionauto-ftp/deploy
docker compose -f docker-compose.ftp.yml up -d --build
docker logs actionauto-ftp -f
```

**Check if server is running:**
```bash
docker ps | grep actionauto-ftp
```

**Restart server:**
```bash
cd /opt/actionauto-ftp/deploy
docker restart actionauto-ftp
```
**Check Logs:**
docker logs actionauto-ftp -f


**Restart**
cd /opt/actionauto-ftp/deploy
docker compose -f docker-compose.ftp.yml up -d --build

---

## VPS Details

**IP Address:** `198.251.79.28`  
**SSH User:** `root`  
**SSH Password:** `Tgm01OkJ`  
**Location:** `/opt/actionauto-ftp`

---

## Security Notes

- ✅ Firewall configured (ports 21, 21000-21010 open)
- ✅ Authentication required (username/password)
- ⚠️ Plain FTP (no encryption) - standard for inventory feeds
- 🔒 Change password after initial testing
- 🔒 Consider adding IP whitelist if DealersCloud provides static IPs

---

## Troubleshooting

**Connection timeout:**
- Check IONOS firewall rules
- Verify Docker container is running
- Check VPS firewall: `sudo ufw status`

**Login failed:**
- Verify username/password
- Check Docker logs for errors

**File not processing:**
- Check Docker logs: `docker logs actionauto-ftp -f`
- Verify file is `.csv` format
- Check MongoDB connection

---

**Last Updated:** January 23, 2026  
**Status:** ✅ Production Ready

---

## API Server Management (Separate from FTP)

**Start/Rebuild API:**
```bash
cd /opt/actionauto-ftp/deploy
docker compose -f docker-compose.api.yml up -d --build
```

**Restart API:**
```bash
docker compose -f docker-compose.api.yml restart api
```

**Check API Logs:**
```bash
docker compose -f docker-compose.api.yml logs -f api
```

**Access API Container Shell:**
```bash
docker exec -it actionauto-api sh
```

**Restart Nginx (after config changes):**
```bash
docker compose -f docker-compose.api.yml restart nginx
```

---

## 🚀 Production Deployment Workflow (Docker Hub)

**Step 1: Local Development (On your PC)**
1. Make your code changes.
2. Run the build script to push changes to Docker Hub:
   ```powershell
   .\scripts\build-and-push.bat
   ```

**Step 2: VPS Deployment (On Server)**
1. SSH into the VPS.
2. Run the update commands:
   ```bash
   cd /opt/actionauto-ftp/deploy
   
   # Stop everything (Safety first)
   docker compose -f docker-compose.api.yml down
   docker compose -f docker-compose.ftp.yml down
   
   # Clean up space (Critical for 10GB disk)
   docker system prune -a --volumes -f
   
   # Pull and Start API
   docker compose -f docker-compose.api.yml pull
   docker compose -f docker-compose.api.yml up -d
   
   # Pull and Start FTP
   docker compose -f docker-compose.ftp.yml pull
   docker compose -f docker-compose.ftp.yml up -d

   docker logs -f actionauto-api
   docker logs -f actionauto-ftp

   docker compose -f docker-compose.local.yml up -d --build
   docker compose -f docker-compose.local.yml --env-file ../.env up -d --build
   ```

[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3000
  }
]


