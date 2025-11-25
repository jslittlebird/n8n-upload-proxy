const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.nacolada.lan/webhook/process-audio-meeting-v2';
const N8N_AUTH_TOKEN = process.env.N8N_AUTH_TOKEN || '';
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '300000'); // 5 minutes

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // Generate or get session ID
    let sessionId = req.headers['x-session-id'];
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      req.headers['x-session-id'] = sessionId;
    }
    const sessionDir = path.join(UPLOAD_DIR, sessionId);

    try {
      await fs.mkdir(sessionDir, { recursive: true });
      cb(null, sessionDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    // Preserve original filename
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB per file
    files: 50 // Max 50 files
  }
});

// In-memory session tracking
const sessions = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    uptime: process.uptime()
  });
});

// Upload endpoint
app.post('/upload', upload.array('data'), async (req, res) => {
  try {
    const sessionId = req.body.session_id || req.headers['x-session-id'] || crypto.randomUUID();
    const isLast = req.body.is_last === 'true' || req.body.is_last === true;
    const context = req.body.context || '';
    const forceTheme = req.body.force_theme || '';
    const forceType = req.body.force_type || '';

    console.log(`[${sessionId}] Received ${req.files.length} files. Is last: ${isLast}`);

    // Initialize or update session
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        files: [],
        metadata: { context, forceTheme, forceType },
        timeout: null,
        createdAt: new Date()
      });
    }

    const session = sessions.get(sessionId);

    // Clear existing timeout
    if (session.timeout) {
      clearTimeout(session.timeout);
    }

    // Add files to session
    if (req.files && req.files.length > 0) {
      session.files.push(...req.files.map(f => ({
        path: f.path,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size
      })));
    }

    // Update metadata if provided
    if (context) session.metadata.context = context;
    if (forceTheme) session.metadata.forceTheme = forceTheme;
    if (forceType) session.metadata.forceType = forceType;

    console.log(`[${sessionId}] Total files in session: ${session.files.length}`);

    if (isLast) {
      // Process immediately
      console.log(`[${sessionId}] Processing session (is_last=true)`);
      await processSession(sessionId);
      res.json({
        success: true,
        sessionId: sessionId,
        filesReceived: session.files.length,
        message: 'Files sent to N8N workflow'
      });
    } else {
      // Set timeout to auto-process if no more files arrive
      session.timeout = setTimeout(async () => {
        console.log(`[${sessionId}] Session timeout reached, processing...`);
        await processSession(sessionId);
      }, SESSION_TIMEOUT_MS);

      res.json({
        success: true,
        sessionId: sessionId,
        filesReceived: session.files.length,
        message: 'Files buffered. Send is_last=true to trigger processing.'
      });
    }

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Process session: send all files to N8N
async function processSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    console.error(`[${sessionId}] Session not found`);
    return;
  }

  try {
    console.log(`[${sessionId}] Sending ${session.files.length} files to N8N...`);

    // Create FormData
    const formData = new FormData();

    // Add all files
    for (const file of session.files) {
      const fileStream = require('fs').createReadStream(file.path);
      formData.append('data', fileStream, {
        filename: file.originalname,
        contentType: file.mimetype
      });
    }

    // Add metadata
    if (session.metadata.context) {
      formData.append('context', session.metadata.context);
    }
    if (session.metadata.forceTheme) {
      formData.append('force_theme', session.metadata.forceTheme);
    }
    if (session.metadata.forceType) {
      formData.append('force_type', session.metadata.forceType);
    }

    // Send to N8N
    const response = await axios.post(N8N_WEBHOOK_URL, formData, {
      headers: {
        ...formData.getHeaders(),
        'X-Auth-Token': N8N_AUTH_TOKEN
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 600000, // 10 minutes
      proxy: false // Disable proxy headers to avoid N8N trust proxy error
    });

    console.log(`[${sessionId}] N8N response:`, response.status, response.data);

    // Cleanup
    await cleanupSession(sessionId);

    console.log(`[${sessionId}] Session processed and cleaned up successfully`);

  } catch (error) {
    console.error(`[${sessionId}] Error processing session:`, error.message);

    // Still try to cleanup
    try {
      await cleanupSession(sessionId);
    } catch (cleanupError) {
      console.error(`[${sessionId}] Cleanup error:`, cleanupError.message);
    }
  }
}

// Cleanup session files and data
async function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) return;

  // Clear timeout
  if (session.timeout) {
    clearTimeout(session.timeout);
  }

  // Delete files
  const sessionDir = path.join(UPLOAD_DIR, sessionId);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
    console.log(`[${sessionId}] Deleted session directory`);
  } catch (error) {
    console.error(`[${sessionId}] Error deleting session directory:`, error.message);
  }

  // Remove from sessions map
  sessions.delete(sessionId);
}

// Cleanup old sessions on startup
async function cleanupOldSessions() {
  try {
    const dirs = await fs.readdir(UPLOAD_DIR);
    for (const dir of dirs) {
      const dirPath = path.join(UPLOAD_DIR, dir);
      const stats = await fs.stat(dirPath);

      if (stats.isDirectory()) {
        // Delete directories older than 1 hour
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs > 3600000) {
          await fs.rm(dirPath, { recursive: true, force: true });
          console.log(`Cleaned up old session: ${dir}`);
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error cleaning up old sessions:', error);
    }
  }
}

// Start server
async function start() {
  // Create upload directory
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  // Cleanup old sessions
  await cleanupOldSessions();

  app.listen(PORT, () => {
    console.log(`Upload Proxy Server running on port ${PORT}`);
    console.log(`Upload directory: ${UPLOAD_DIR}`);
    console.log(`N8N webhook: ${N8N_WEBHOOK_URL}`);
    console.log(`Session timeout: ${SESSION_TIMEOUT_MS}ms`);
  });
}

start().catch(console.error);
