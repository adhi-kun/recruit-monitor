import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { config } from './config.js';
import authRoutes from './routes/auth.js';
import roomRoutes from './routes/rooms.js';
import { setupSockets } from './socket/index.js';
import { initDatabase } from './db/database.js';

// Validate critical env vars
if (!config.jwtSecret) {
  throw new Error('JWT_SECRET is missing in .env');
}

if (!config.clientOrigin) {
  throw new Error('CLIENT_ORIGIN is missing in .env');
}

const app = express();

// Security middleware
app.use(helmet());

// Development-friendly CORS
app.use(cors({
  origin: true,
  credentials: true
}));

// Body parser
app.use(express.json());

// Routes
app.use('/auth', authRoutes);
app.use('/rooms', roomRoutes);

// Health check
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Create HTTP server
const httpServer = http.createServer(app);

// Setup Socket.IO
setupSockets(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});

// Initialize DB and start server
initDatabase()
  .then(() => {
    httpServer.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Client origin: ${config.clientOrigin}`);
      console.log('Database initialized (SQLite WAL mode)');
    });
  })
  .catch((err) => {
    console.error('Failed to initialize server:', err);
    process.exit(1);
  });