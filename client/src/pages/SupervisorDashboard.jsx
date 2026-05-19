import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore.js';
import { useRoomStore } from '../store/useRoomStore.js';
import { useSocket, disconnectAll } from '../hooks/useSocket.js';
import ActiveRoomCard from '../components/ActiveRoomCard.jsx';

export default function SupervisorDashboard() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const activeRooms = useRoomStore((s) => s.activeRooms);
  const setActiveRooms = useRoomStore((s) => s.setActiveRooms);
  const setRoom = useRoomStore((s) => s.setRoom);
  const setUserRole = useRoomStore((s) => s.setUserRole);

  const [toast, setToast] = useState(null);
  const socket = useSocket('supervisor');

  useEffect(() => {
    if (!socket) return;
    const handleActiveRooms = ({ rooms }) => setActiveRooms(rooms);
    const handleError = ({ message }) => {
      setToast({ type: 'error', message });
      setTimeout(() => setToast(null), 4000);
    };
    socket.on('supervisor:active-rooms', handleActiveRooms);
    socket.on('error:room', handleError);
    return () => {
      socket.off('supervisor:active-rooms', handleActiveRooms);
      socket.off('error:room', handleError);
    };
  }, [socket, setActiveRooms]);

  const handleMonitor = useCallback((room) => {
    if (!socket) return;
    setRoom({ roomId: room.roomId, roomCode: room.roomCode, rtcChannelName: room.rtcChannelName });
    setUserRole('supervisor');
    socket.emit('supervisor:join-room', { roomId: room.roomId });
    navigate(`/room/${room.roomId}`);
  }, [socket, setRoom, setUserRole, navigate]);

  const handleLogout = useCallback(() => {
    logout();
    disconnectAll();
    navigate('/');
  }, [logout, navigate]);

  return (
    <div className="flex-1 flex flex-col">
      {toast && (
        <div className={`toast-${toast.type}`}>
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <span className="text-sm font-medium">{toast.message}</span>
          </div>
        </div>
      )}

      <header className="border-b border-surface-800 bg-surface-950/80 backdrop-blur-lg sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-surface-50">RecruitMonitor</h1>
              <p className="text-xs text-surface-400">Supervisor Dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-surface-300">Welcome, <span className="text-surface-100 font-medium">{user?.name}</span></span>
            <button onClick={handleLogout} className="btn-secondary text-sm px-4 py-2">Logout</button>
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 py-8">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-bold text-surface-50">Active Interviews</h2>
              <p className="text-surface-400 mt-1">
                {activeRooms.length === 0 ? 'No active interviews' : `${activeRooms.length} active interview${activeRooms.length > 1 ? 's' : ''}`}
              </p>
            </div>
            <div className="flex items-center gap-2 text-sm text-surface-500">
              <div className="w-2 h-2 rounded-full bg-success-400 animate-pulse" />
              Live monitoring
            </div>
          </div>

          {activeRooms.length === 0 ? (
            <div className="glass-card p-16 text-center animate-fade-in">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-surface-800/80 border border-surface-700/30 flex items-center justify-center">
                <svg className="w-10 h-10 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-surface-300 mb-2">No Active Interviews</h3>
              <p className="text-surface-500 max-w-md mx-auto">When interviewers create rooms, they'll appear here for monitoring.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 animate-fade-in">
              {activeRooms.map((room) => (
                <ActiveRoomCard key={room.roomId} room={room} onMonitor={() => handleMonitor(room)} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
