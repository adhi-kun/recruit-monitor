import { io } from 'socket.io-client';
import { SOCKET_URL } from '../config.js';
import { useAuthStore } from '../store/useAuthStore.js';

// Module-level singletons — survive component remounts
const sockets = {
  interviewer: null,
  candidate: null,
  supervisor: null
};

export function getSocket(role) {
  if (sockets[role]) return sockets[role];

  const token = useAuthStore.getState().token;

  const opts = {
    autoConnect: true,
    auth: role !== 'candidate' ? { token } : undefined
  };

  sockets[role] = io(`${SOCKET_URL}/${role}`, opts);
  return sockets[role];
}

export function disconnectSocket(role) {
  if (sockets[role]) {
    sockets[role].disconnect();
    sockets[role] = null;
  }
}

export function disconnectAll() {
  Object.keys(sockets).forEach(disconnectSocket);
}

// Hook wrapper for use in components
export function useSocket(role) {
  const socket = getSocket(role);
  return socket;
}
