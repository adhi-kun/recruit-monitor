import { MAX_AUDIO_CHUNK_SIZE } from '../services/deepgram/DeepgramSession.js';

export function setupCandidateHandlers(
  interviewerNS, candidateNS, supervisorNS,
  broadcastToRoom, broadcastActiveRoomUpdate,
  roomRegistry, sanitizeRoom, deepgramManager
) {
  candidateNS.on('connection', (socket) => {
    console.log(`Candidate connected: ${socket.id}`);

    // Rate limiter state per socket connection
    const MAX_CHUNKS_PER_SECOND = 100;
    let chunkCount = 0;
    let chunkWindowStart = Date.now();

    // candidate:join
    socket.on('candidate:join', ({ roomCode, candidateName }) => {
      const room = roomRegistry.getRoomByCode(roomCode.toUpperCase().trim());

      if (!room) {
        socket.emit('error:room', { message: 'Room not found. Check the code and try again.' });
        return;
      }
      if (room.status === 'ended') {
        socket.emit('error:room', { message: 'This room has ended.' });
        return;
      }
      if (room.candidateSocketId && room.candidateSocketId !== socket.id) {
        socket.emit('error:room', { message: 'A candidate has already joined this room.' });
        return;
      }

      roomRegistry.updateRoom(room.roomId, {
        candidateSocketId: socket.id,
        candidateName: candidateName.trim(),
        status: 'active'
      });
      socket.join(room.roomId);

      // Start Deepgram session for this room
      deepgramManager.startSession(room.roomId, broadcastToRoom, roomRegistry);

      // Confirm back to candidate with roomId
      socket.emit('room:candidate-confirmed', {
        roomId: room.roomId,
        rtcChannelName: room.rtcChannelName,
        transcriptText: room.transcriptText
      });

      // Notify interviewer
      interviewerNS.to(room.roomId).emit('room:candidate-joined', {
        candidateName: candidateName.trim()
      });

      console.log(`Candidate "${candidateName.trim()}" joined room ${room.roomCode}`);
      broadcastActiveRoomUpdate();
    });

    // candidate:rejoin — after browser refresh
    socket.on('candidate:rejoin', ({ roomCode, candidateName }) => {
      const room = roomRegistry.getRoomByCode(roomCode.toUpperCase().trim());
      if (!room || room.status === 'ended') {
        socket.emit('error:room', { message: 'Room no longer available.' });
        return;
      }
      roomRegistry.updateRoom(room.roomId, { candidateSocketId: socket.id });
      socket.join(room.roomId);

      // Start/resume Deepgram session for this room
      deepgramManager.startSession(room.roomId, broadcastToRoom, roomRegistry);

      // Restore state to candidate
      socket.emit('room:candidate-confirmed', {
        roomId: room.roomId,
        rtcChannelName: room.rtcChannelName,
        transcriptText: room.transcriptText
      });

      console.log(`Candidate "${candidateName}" rejoined room ${room.roomCode}`);
    });

    // transcript:audio-chunk — binary PCM audio from candidate
    socket.on('transcript:audio-chunk', (data) => {
      // Security: verify this socket is the current candidate for the room
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room || room.candidateSocketId !== socket.id) return;

      // Binary validation
      if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) return;
      if (data.byteLength === 0 || data.byteLength > MAX_AUDIO_CHUNK_SIZE) return;
      if (data.byteLength % 2 !== 0) return; // PCM Int16 alignment

      // Rate limiting — sliding window per socket
      const now = Date.now();
      if (now - chunkWindowStart >= 1000) {
        chunkCount = 0;
        chunkWindowStart = now;
      }
      chunkCount++;
      if (chunkCount > MAX_CHUNKS_PER_SECOND) return; // silently drop excess

      deepgramManager.sendAudio(room.roomId, data);
    });

    // candidate:leave
    socket.on('candidate:leave', () => {
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room) return;
      console.log(`Candidate leaving room ${room.roomCode}`);
      deepgramManager.pauseSession(room.roomId);
      roomRegistry.updateRoom(room.roomId, {
        candidateSocketId: null,
        candidateName: null,
        status: 'waiting'
      });
      socket.leave(room.roomId);
      interviewerNS.to(room.roomId).emit('room:candidate-left', {});
      broadcastActiveRoomUpdate();
    });

    // disconnect
    socket.on('disconnect', () => {
      console.log(`Candidate disconnected: ${socket.id}`);
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room) return;
      deepgramManager.pauseSession(room.roomId);
      roomRegistry.updateRoom(room.roomId, { candidateSocketId: null, status: 'waiting' });
      interviewerNS.to(room.roomId).emit('room:candidate-left', {});
      broadcastActiveRoomUpdate();
    });
  });
}
