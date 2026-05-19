export function setupSupervisorHandlers(
  interviewerNS, candidateNS, supervisorNS,
  broadcastToRoom, broadcastActiveRoomUpdate,
  roomRegistry, sanitizeRoom
) {
  supervisorNS.on('connection', (socket) => {
    console.log(`Supervisor connected: ${socket.id} (${socket.user.email})`);

    // Send active rooms immediately on connect
    const rooms = roomRegistry.getAllActiveRooms().map(sanitizeRoom);
    socket.emit('supervisor:active-rooms', { rooms });

    // supervisor:join-room
    socket.on('supervisor:join-room', ({ roomId }) => {
      const room = roomRegistry.getRoomById(roomId);
      if (!room) {
        socket.emit('error:room', { message: 'Room not found.' });
        return;
      }
      // One supervisor per room
      if (room.supervisorSocketId && room.supervisorSocketId !== socket.id) {
        socket.emit('error:room', { message: 'Another supervisor is already monitoring this interview.' });
        return;
      }

      // Leave previous room if monitoring a different one
      const prev = roomRegistry.getRoomBySocketId(socket.id);
      if (prev && prev.roomId !== roomId) {
        roomRegistry.updateRoom(prev.roomId, { supervisorSocketId: null });
        socket.leave(prev.roomId);
      }

      roomRegistry.updateRoom(roomId, { supervisorSocketId: socket.id });
      socket.join(roomId);

      // Send current transcript immediately
      socket.emit('transcript:broadcast', { text: room.transcriptText });

      console.log(`Supervisor joined room ${room.roomCode}`);
      broadcastActiveRoomUpdate();
    });

    // supervisor:leave-room
    socket.on('supervisor:leave-room', () => {
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (!room) return;
      console.log(`Supervisor left room ${room.roomCode}`);
      roomRegistry.updateRoom(room.roomId, { supervisorSocketId: null });
      socket.leave(room.roomId);
      broadcastActiveRoomUpdate();
    });

    socket.on('disconnect', () => {
      console.log(`Supervisor disconnected: ${socket.id}`);
      const room = roomRegistry.getRoomBySocketId(socket.id);
      if (room) {
        roomRegistry.updateRoom(room.roomId, { supervisorSocketId: null });
        broadcastActiveRoomUpdate();
      }
    });
  });
}
