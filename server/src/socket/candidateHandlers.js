import { enforceRateLimit } from '../utils/socketRateLimiter.js';
import { logger } from '../utils/logger.js';
import {
  isActiveRoom,
  isCandidateSocketForRoom,
  isValidAudioChunk,
  normalizeDisplayName,
  normalizeRoomCode,
} from '../utils/socketSecurity.js';

export function setupCandidateHandlers(
  interviewerNS, candidateNS, supervisorNS,
  broadcastToRoom, broadcastActiveRoomUpdate,
  roomRegistry, sanitizeRoom, deepgramManager, rateLimiter
) {
  candidateNS.on('connection', (socket) => {
    logger.info('candidate connected', {
      namespace: '/candidate',
      socketId: socket.id,
    });

    let audioChunkCount = 0;

    function attachCandidateToRoom(room, candidateName) {
      roomRegistry.updateRoom(room.roomId, {
        candidateSocketId: socket.id,
        candidateName,
        status: 'active',
      });
      socket.data.role = 'candidate';
      socket.data.roomId = room.roomId;
      socket.data.candidateName = candidateName;
      socket.join(room.roomId);
      deepgramManager.startSession(room.roomId, broadcastToRoom, roomRegistry);
    }

    socket.on('candidate:join', ({ roomCode, candidateName } = {}) => {
      const safeRoomCode = normalizeRoomCode(roomCode);
      const safeName = normalizeDisplayName(candidateName);
      if (!safeRoomCode || !safeName) {
        socket.emit('error:room', { message: 'Invalid room code or name.' });
        return;
      }

      if (!enforceRateLimit({
        socket,
        limiter: rateLimiter,
        event: 'candidate:join',
        roomId: safeRoomCode,
        logger,
        namespace: '/candidate',
      })) return;

      const room = roomRegistry.getRoomByCode(safeRoomCode);
      if (!room) {
        socket.emit('error:room', { message: 'Room not found. Check the code and try again.' });
        return;
      }
      if (!isActiveRoom(room)) {
        socket.emit('error:room', { message: 'This room has ended.' });
        return;
      }
      if (room.candidateSocketId && room.candidateSocketId !== socket.id) {
        socket.emit('error:room', { message: 'A candidate has already joined this room.' });
        return;
      }

      attachCandidateToRoom(room, safeName);

      socket.emit('room:candidate-confirmed', {
        roomId: room.roomId,
        rtcChannelName: room.rtcChannelName,
        transcriptText: room.transcriptText,
      });

      interviewerNS.to(room.roomId).emit('room:candidate-joined', {
        candidateName: safeName,
      });

      logger.info('candidate joined room', {
        namespace: '/candidate',
        socketId: socket.id,
        roomId: room.roomId,
      });
      broadcastActiveRoomUpdate();
    });

    socket.on('candidate:rejoin', ({ roomCode, candidateName } = {}) => {
      const safeRoomCode = normalizeRoomCode(roomCode);
      const safeName = normalizeDisplayName(candidateName);
      if (!safeRoomCode || !safeName) {
        socket.emit('error:room', { message: 'Invalid room code or name.' });
        return;
      }

      if (!enforceRateLimit({
        socket,
        limiter: rateLimiter,
        event: 'candidate:rejoin',
        roomId: safeRoomCode,
        logger,
        namespace: '/candidate',
      })) return;

      const room = roomRegistry.getRoomByCode(safeRoomCode);
      if (!isActiveRoom(room)) {
        socket.emit('error:room', { message: 'Room no longer available.' });
        return;
      }
      if (room.candidateSocketId && room.candidateSocketId !== socket.id) {
        socket.emit('error:room', { message: 'A candidate has already joined this room.' });
        return;
      }

      attachCandidateToRoom(room, safeName);

      socket.emit('room:candidate-confirmed', {
        roomId: room.roomId,
        rtcChannelName: room.rtcChannelName,
        transcriptText: room.transcriptText,
      });

      logger.info('candidate rejoined room', {
        namespace: '/candidate',
        socketId: socket.id,
        roomId: room.roomId,
      });
      broadcastActiveRoomUpdate();
    });

    socket.on('transcript:audio-chunk', (data) => {
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!isActiveRoom(room) || !isCandidateSocketForRoom(socket, room)) return;
      if (!enforceRateLimit({
        socket,
        limiter: rateLimiter,
        event: 'transcript:audio-chunk',
        roomId: room.roomId,
        logger,
        namespace: '/candidate',
      })) return;
      if (!isValidAudioChunk(data)) return;

      deepgramManager.sendAudio(room.roomId, data);
      audioChunkCount++;
      if (audioChunkCount === 1 || audioChunkCount % 500 === 0) {
        logger.info('candidate audio flowing', {
          namespace: '/candidate',
          socketId: socket.id,
          roomId: room.roomId,
          totalChunks: audioChunkCount,
        });
      }
    });

    socket.on('candidate:leave', () => {
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room || room.candidateSocketId !== socket.id) return;

      logger.info('candidate leaving room', {
        namespace: '/candidate',
        socketId: socket.id,
        roomId: room.roomId,
      });
      deepgramManager.pauseSession(room.roomId);
      roomRegistry.updateRoom(room.roomId, {
        candidateSocketId: null,
        candidateName: null,
        status: 'waiting',
      });
      socket.data.role = null;
      socket.data.roomId = null;
      socket.leave(room.roomId);
      interviewerNS.to(room.roomId).emit('room:candidate-left', {});
      broadcastActiveRoomUpdate();
    });

    socket.on('disconnect', (reason) => {
      logger.info('candidate disconnected', {
        namespace: '/candidate',
        socketId: socket.id,
        roomId: socket.data?.roomId,
        reason,
      });
      rateLimiter.cleanupSocket(socket.id);

      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room || room.candidateSocketId !== socket.id) return;
      deepgramManager.pauseSession(room.roomId);
      roomRegistry.updateRoom(room.roomId, { candidateSocketId: null, status: 'waiting' });
      interviewerNS.to(room.roomId).emit('room:candidate-left', {});
      broadcastActiveRoomUpdate();
    });
  });
}
