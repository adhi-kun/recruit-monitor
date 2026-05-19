import { v4 as uuidv4 } from 'uuid';

// ── In-memory room state ─────────────────────────────────────────────
const rooms = new Map();    // Map<roomId, ActiveRoom>
const codes = new Map();    // Map<roomCode, roomId>

// Characters for room code generation — excludes ambiguous chars (0, O, 1, I)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    }
  } while (codes.has(code)); // collision check
  return code;
}

/**
 * Create a new interview room.
 * @param {string} interviewerSocketId
 * @param {string} interviewerName
 * @returns {object} ActiveRoom
 */
export function createRoom(interviewerSocketId, interviewerName) {
  const roomId = uuidv4();
  const roomCode = generateRoomCode();
  const rtcChannelName = `interview_${roomId}`;

  const room = {
    roomId,
    roomCode,
    rtcChannelName,
    interviewerSocketId,
    interviewerName,
    candidateSocketId: null,
    candidateName: null,
    supervisorSocketId: null,
    transcriptText: '',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    status: 'waiting'
  };

  rooms.set(roomId, room);
  codes.set(roomCode, roomId);
  return room;
}

/**
 * Get a room by its 6-char code.
 * @param {string} roomCode
 * @returns {object|null}
 */
export function getRoomByCode(roomCode) {
  const roomId = codes.get(roomCode);
  if (!roomId) return null;
  return rooms.get(roomId) || null;
}

/**
 * Get a room by its UUID.
 * @param {string} roomId
 * @returns {object|null}
 */
export function getRoomById(roomId) {
  return rooms.get(roomId) || null;
}

/**
 * Find a room where the given socketId is any participant.
 * @param {string} socketId
 * @returns {object|null}
 */
export function getRoomBySocketId(socketId) {
  for (const room of rooms.values()) {
    if (
      room.interviewerSocketId === socketId ||
      room.candidateSocketId === socketId ||
      room.supervisorSocketId === socketId
    ) {
      return room;
    }
  }
  return null;
}

/**
 * Patch a room with new data. Always updates lastActivityAt.
 * @param {string} roomId
 * @param {object} patch
 * @returns {object} updated room
 */
export function updateRoom(roomId, patch) {
  const room = rooms.get(roomId);
  if (!room) return null;
  Object.assign(room, patch, { lastActivityAt: new Date() });
  return room;
}

/**
 * Terminate and remove a room from both maps.
 * @param {string} roomId
 * @returns {object} the deleted room
 */
export function terminateRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  rooms.delete(roomId);
  codes.delete(room.roomCode);
  return room;
}

/**
 * Get all non-ended rooms.
 * @returns {Array}
 */
export function getAllActiveRooms() {
  return Array.from(rooms.values()).filter(r => r.status !== 'ended');
}

/**
 * Clean up rooms idle for more than 30 minutes.
 * Calls cb(roomId) for each terminated room.
 * @param {function} cb
 */
export function cleanupIdleRooms(cb) {
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000;

  for (const room of rooms.values()) {
    if (now - room.lastActivityAt.getTime() > thirtyMinutes) {
      terminateRoom(room.roomId);
      if (cb) cb(room.roomId);
    }
  }
}
