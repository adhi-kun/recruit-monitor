import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { config } from './config.js';
import authRoutes from './routes/auth.js';
import roomRoutes from './routes/rooms.js';
import { setupSockets } from './socket/index.js';
import { supabase } from './lib/supabase.js';

// Validate critical env vars
if (!config.jwtSecret) {
  throw new Error('JWT_SECRET is missing in .env');
}

if (!config.clientOrigin) {
  throw new Error('CLIENT_ORIGIN is missing in .env');
}

if (!process.env.SUPABASE_URL) {
  throw new Error('SUPABASE_URL is missing in .env');
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing in .env');
}

const app = express();

const allowedOrigins = [
  config.clientOrigin,
  config.clientOriginProd
].filter(Boolean);

// Security middleware
app.use(helmet());

// Development-friendly CORS
app.use(cors({
  origin: true,
  credentials: true
}));

// Body parser
app.use(express.json());

/* =========================
   TEST SUPABASE LOGIN ROUTE
   TEMPORARY
========================= */

app.post('/test-login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    const { data, error } =
      await supabase.auth.signInWithPassword({
        email,
        password
      });

    if (error) {
      return res.status(401).json({
        error: error.message
      });
    }

    return res.json({
      success: true,
      user: data.user,
      session: data.session
    });

  } catch (err) {
    console.error('Test login error:', err);

    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

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

app.get('/test-route', (_, res) => {
  res.json({
    ok: true
  });
});

// Setup Socket.IO
setupSockets(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});

httpServer.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log('Supabase integration initialized');
});