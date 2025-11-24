# N8N Upload Proxy

Upload proxy server for N8N to handle large multi-file uploads without ENOENT errors.

## Problem Solved

When uploading multiple large files (>100 MB total) directly to N8N webhooks, temporary files are deleted by Node.js middleware before N8N can process them, causing `ENOENT` errors.

This proxy:
- Receives files progressively (no timeout limits)
- Buffers them temporarily with a session ID
- Sends all files at once to N8N when complete
- Cleans up automatically

## Features

- ✅ **Session-based uploads**: Group multiple files under a single session
- ✅ **Progressive uploads**: Send files one by one or in batches
- ✅ **Auto-timeout**: Automatically processes session after inactivity
- ✅ **Large file support**: Up to 500 MB per file, 50 files per session
- ✅ **Auto-cleanup**: Removes old sessions and files
- ✅ **Docker ready**: Easy deployment with Docker Compose

## Architecture

```
Client (curl/script) → Upload Proxy → N8N Webhook
                       │
                       └─ Buffers files per session
                       └─ Sends all at once when ready
                       └─ Cleans up automatically
```

## Installation

### Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your configuration

# Start server
npm start

# Or with auto-reload
npm run dev
```

### Docker Deployment

```bash
# Build image
docker build -t n8n-upload-proxy .

# Run with docker-compose
docker-compose up -d
```

## Usage

### Method 1: Progressive Upload (Multiple Requests)

Send files one by one or in batches:

```bash
SESSION_ID=$(uuidgen)

# Send file 1
curl -X POST http://localhost:3000/upload \
  -F "data=@file1.mp3" \
  -F "session_id=$SESSION_ID" \
  -F "context=My audit context"

# Send file 2
curl -X POST http://localhost:3000/upload \
  -F "data=@file2.mp3" \
  -F "session_id=$SESSION_ID"

# Send last file and trigger processing
curl -X POST http://localhost:3000/upload \
  -F "data=@file3.mp3" \
  -F "session_id=$SESSION_ID" \
  -F "is_last=true"
```

### Method 2: Single Request (All Files)

Send all files at once:

```bash
curl -X POST http://localhost:3000/upload \
  -F "data=@file1.mp3" \
  -F "data=@file2.mp3" \
  -F "data=@file3.mp3" \
  -F "context=My audit context" \
  -F "force_theme=cybersecurity" \
  -F "force_type=audit" \
  -F "is_last=true"
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `data` | Yes | Files to upload (can be multiple) |
| `session_id` | No | Session identifier (auto-generated if not provided) |
| `is_last` | No | Set to `true` to trigger immediate processing |
| `context` | No | Context for N8N workflow |
| `force_theme` | No | Theme for N8N workflow (e.g., `cybersecurity`) |
| `force_type` | No | Type for N8N workflow (e.g., `audit`) |

### Response

```json
{
  "success": true,
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "filesReceived": 3,
  "message": "Files sent to N8N workflow"
}
```

## Configuration

Environment variables (see `.env.example`):

```env
# Server port
PORT=3000

# Upload directory (relative or absolute)
UPLOAD_DIR=./uploads

# N8N webhook URL
N8N_WEBHOOK_URL=https://n8n.nacolada.lan/webhook/process-audio-meeting-v2

# N8N authentication token
N8N_AUTH_TOKEN=your_token_here

# Session timeout in milliseconds (default: 5 minutes)
SESSION_TIMEOUT_MS=300000
```

## How It Works

### Session Flow

1. **File Upload**: Client sends file(s) with a `session_id`
2. **Buffering**: Proxy stores files in `uploads/[session_id]/`
3. **Timeout**: After `SESSION_TIMEOUT_MS` of inactivity, or when `is_last=true`
4. **Processing**: Proxy sends all files to N8N webhook
5. **Cleanup**: Files and session data are deleted

### Auto-Cleanup

- Sessions older than 1 hour are deleted on server startup
- Files are deleted after successful N8N processing
- Timeout-based cleanup prevents abandoned sessions

## Deployment on Nacolada

### 1. Copy files to server

```bash
scp -r upload-proxy jsklein@192.168.1.187:~/
```

### 2. SSH to server

```bash
ssh jsklein@192.168.1.187
```

### 3. Configure environment

```bash
cd ~/upload-proxy
cp .env.example .env
nano .env  # Edit with your N8N credentials
```

### 4. Start with Docker Compose

```bash
docker-compose up -d
```

### 5. Check logs

```bash
docker logs -f n8n-upload-proxy
```

### 6. Test

```bash
curl http://localhost:3030/health
```

## Integration with Scripts

Update your upload scripts to use the proxy:

```bash
# Before (direct to N8N - causes ENOENT)
WEBHOOK_URL="https://n8n.nacolada.lan/webhook/process-audio-meeting-v2"

# After (via proxy - works perfectly)
WEBHOOK_URL="http://localhost:3030/upload"
```

Add `is_last=true` to the last file:

```bash
# Send all files
for file in *.mp3; do
  curl -X POST "$WEBHOOK_URL" \
    -F "data=@$file" \
    -F "session_id=$SESSION_ID" \
    -F "context=My context"
done

# Trigger processing
curl -X POST "$WEBHOOK_URL" \
  -F "session_id=$SESSION_ID" \
  -F "is_last=true"
```

## Health Check

```bash
curl http://localhost:3030/health
```

Response:
```json
{
  "status": "ok",
  "activeSessions": 2,
  "uptime": 3600.5
}
```

## Troubleshooting

### Port already in use

Change `PORT` in `.env` or `docker-compose.yml`

### Files not being sent to N8N

1. Check logs: `docker logs n8n-upload-proxy`
2. Verify `N8N_WEBHOOK_URL` is correct
3. Verify `N8N_AUTH_TOKEN` is valid

### Session timeout too short

Increase `SESSION_TIMEOUT_MS` in `.env` (in milliseconds)

### Out of disk space

Check `uploads/` directory and increase cleanup frequency

## License

MIT

## Author

Created for the AudioMeetingsProcessor project
