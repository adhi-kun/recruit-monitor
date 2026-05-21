import { Server } from 'socket.io';

import { socketAuth } from '../middleware/auth.js';
import * as roomRegistry from '../state/roomRegistry.js';

import { setupInterviewerHandlers } from './interviewerHandlers.js';
import { setupCandidateHandlers } from './candidateHandlers.js';
import { setupSupervisorHandlers } from './supervisorHandlers.js';
import { DeepgramManager } from '../services/deepgram/DeepgramManager.js';

export function setupSockets(httpServer, socketCorsConfig = {}) {
  // Create Socket.IO server
  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST'],
      transports: ['websocket', 'polling'],
      ...(socketCorsConfig.cors || {})
    }
  });

  // Namespaces
  const interviewerNS = io.of('/interviewer');
  const candidateNS = io.of('/candidate');
  const supervisorNS = io.of('/supervisor');

  // JWT auth middleware
  interviewerNS.use(socketAuth);
  supervisorNS.use(socketAuth);

  // Candidate namespace intentionally has NO JWT auth
  // Room code acts as temporary credential

  // ─────────────────────────────────────────────────────────────
  // Broadcast helper
  // Socket.IO rooms are namespace-scoped
  // so broadcasts must hit all namespaces manually
  // ─────────────────────────────────────────────────────────────
  function broadcastToRoom(roomId, event, data) {
    interviewerNS.to(roomId).emit(event, data);
    candidateNS.to(roomId).emit(event, data);
    supervisorNS.to(roomId).emit(event, data);
  }

  // ─────────────────────────────────────────────────────────────
  // Remove sensitive socket IDs before supervisor exposure
  // ─────────────────────────────────────────────────────────────
  function sanitizeRoom(room) {
    const {
      interviewerSocketId,
      candidateSocketId,
      supervisorSocketId,
      ...safe
    } = room;

    return {
      ...safe,
      isMonitored: !!supervisorSocketId
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Push active room list to all supervisors
  // ─────────────────────────────────────────────────────────────
  function broadcastActiveRoomUpdate() {
    const rooms = roomRegistry
      .getAllActiveRooms()
      .map(sanitizeRoom);

    supervisorNS.emit('supervisor:active-rooms', {
      rooms
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Deepgram session manager
  // ─────────────────────────────────────────────────────────────
  const deepgramManager = new DeepgramManager();

  // ─────────────────────────────────────────────────────────────
  // Register namespace handlers
  // ─────────────────────────────────────────────────────────────
  setupInterviewerHandlers(
    interviewerNS,
    candidateNS,
    supervisorNS,
    broadcastToRoom,
    broadcastActiveRoomUpdate,
    roomRegistry,
    sanitizeRoom,
    deepgramManager
  );

  setupCandidateHandlers(
    interviewerNS,
    candidateNS,
    supervisorNS,
    broadcastToRoom,
    broadcastActiveRoomUpdate,
    roomRegistry,
    sanitizeRoom,
    deepgramManager
  );

  setupSupervisorHandlers(
    interviewerNS,
    candidateNS,
    supervisorNS,
    broadcastToRoom,
    broadcastActiveRoomUpdate,
    roomRegistry,
    sanitizeRoom
  );

  // ─────────────────────────────────────────────────────────────
  // Cleanup idle rooms periodically
  // ─────────────────────────────────────────────────────────────
  setInterval(() => {
    roomRegistry.cleanupIdleRooms((roomId) => {
      deepgramManager.stopSession(roomId);
      broadcastToRoom(roomId, 'room:terminated', {
        reason: 'Room expired due to inactivity'
      });

      broadcastActiveRoomUpdate();
    });
  }, 5 * 60 * 1000);

  // ─────────────────────────────────────────────────────────────
  // Graceful shutdown — stop all Deepgram sessions
  // ─────────────────────────────────────────────────────────────
  process.once('SIGTERM', () => deepgramManager.stopAll());
  process.once('SIGINT',  () => deepgramManager.stopAll());

  // ─────────────────────────────────────────────────────────────
  // Logging
  // ─────────────────────────────────────────────────────────────
  console.log(
    'Socket.IO namespaces initialized: /interviewer, /candidate, /supervisor'
  );
}