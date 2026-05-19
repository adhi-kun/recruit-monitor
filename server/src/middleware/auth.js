import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Express middleware: verify JWT from Authorization header.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }
  try {
    req.user = jwt.verify(header.slice(7), config.jwtSecret);
    next();
  } catch (err) {
    console.warn('JWT verification failed:', err.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Express middleware factory: restrict to a specific role.
 * @param {string} role
 */
export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

/**
 * Socket.IO middleware: verify JWT from handshake auth.
 * Used on interviewer and supervisor namespaces.
 */
export function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch (err) {
    console.warn('Socket auth failed:', err.message);
    next(new Error('Invalid or expired token'));
  }
}
