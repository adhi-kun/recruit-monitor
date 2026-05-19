export function setupInterviewerHandlers(
  interviewerNS, candidateNS, supervisorNS,
  broadcastToRoom, broadcastActiveRoomUpdate,
  roomRegistry, sanitizeRoom
) {
  interviewerNS.on('connection', (socket) => {
    console.log(`Interviewer connected: ${socket.id} (${socket.user.email})`);

    // interviewer:create-room
    socket.on('interviewer:create-room', ({ interviewerName }) => {
      // Clean up any existing room this interviewer owns
      const existing = roomRegistry.getRoomBySocketId(socket.id);
      if (existing) {
        roomRegistry.terminateRoom(existing.roomId);
        broadcastToRoom(existing.roomId, 'room:terminated', { reason: 'Interviewer created a new room' });
        broadcastActiveRoomUpdate();
      }

      const room = roomRegistry.createRoom(socket.id, interviewerName);
      socket.join(room.roomId);

      socket.emit('room:created', {
        roomId: room.roomId,
        roomCode: room.roomCode,
        rtcChannelName: room.rtcChannelName
      });

      console.log(`Room created: ${room.roomCode} (${room.roomId})`);
      broadcastActiveRoomUpdate();
    });

    // transcript:update — interviewer edits transcript
    socket.on('transcript:update', ({ roomId, text }) => {
      const room = roomRegistry.getRoomById(roomId);
      if (!room || room.interviewerSocketId !== socket.id) return;
      roomRegistry.updateRoom(roomId, { transcriptText: text });
      broadcastToRoom(roomId, 'transcript:broadcast', { text });
    });

    // interviewer:leave — explicit
    socket.on('interviewer:leave', () => {
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room) return;
      console.log(`Interviewer leaving room: ${room.roomCode}`);
      roomRegistry.terminateRoom(room.roomId);
      broadcastToRoom(room.roomId, 'room:terminated', { reason: 'Interviewer ended the session' });
      broadcastActiveRoomUpdate();
    });

    // disconnect — browser close, refresh, crash, network drop
    socket.on('disconnect', () => {
      console.log(`Interviewer disconnected: ${socket.id}`);
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room) return;
      roomRegistry.terminateRoom(room.roomId);
      broadcastToRoom(room.roomId, 'room:terminated', { reason: 'Interviewer disconnected' });
      broadcastActiveRoomUpdate();
    });
  });
}
