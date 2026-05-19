export function setupCandidateHandlers(
  interviewerNS, candidateNS, supervisorNS,
  broadcastToRoom, broadcastActiveRoomUpdate,
  roomRegistry, sanitizeRoom
) {
  candidateNS.on('connection', (socket) => {
    console.log(`Candidate connected: ${socket.id}`);

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

      // Restore state to candidate
      socket.emit('room:candidate-confirmed', {
        roomId: room.roomId,
        rtcChannelName: room.rtcChannelName,
        transcriptText: room.transcriptText
      });

      console.log(`Candidate "${candidateName}" rejoined room ${room.roomCode}`);
    });

    // transcript:update — candidate's Deepgram results
    socket.on('transcript:update', ({ roomId, text }) => {
      const room = roomRegistry.getRoomById(roomId);
      if (!room || room.candidateSocketId !== socket.id) return;
      roomRegistry.updateRoom(roomId, { transcriptText: text });
      broadcastToRoom(roomId, 'transcript:broadcast', { text });
    });

    // candidate:leave
    socket.on('candidate:leave', () => {
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room) return;
      console.log(`Candidate leaving room ${room.roomCode}`);
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
      roomRegistry.updateRoom(room.roomId, { candidateSocketId: null, status: 'waiting' });
      interviewerNS.to(room.roomId).emit('room:candidate-left', {});
      broadcastActiveRoomUpdate();
    });
  });
}
