import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore.js';
import { useRoomStore } from '../store/useRoomStore.js';
import { useSocket, disconnectAll } from '../hooks/useSocket.js';

export default function InterviewerDashboard() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setRoom = useRoomStore((s) => s.setRoom);
  const setUserRole = useRoomStore((s) => s.setUserRole);
  const setInterviewerName = useRoomStore((s) => s.setInterviewerName);
  const setCandidateJoined = useRoomStore((s) => s.setCandidateJoined);

  const [roomCode, setRoomCode] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);

  const socket = useSocket('interviewer');

  useEffect(() => {
    if (!socket) return;

    const handleRoomCreated = ({ roomId, roomCode, rtcChannelName }) => {
      setRoomId(roomId);
      setRoomCode(roomCode);
      setWaiting(true);
      setRoom({ roomId, roomCode, rtcChannelName });
      setUserRole('interviewer');
      setInterviewerName(user.name);
    };

    const handleCandidateJoined = ({ candidateName }) => {
      setCandidateJoined(candidateName);
      navigate(`/room/${roomId}`);
    };

    const handleError = ({ message }) => {
      console.warn('Room error:', message);
    };

    socket.on('room:created', handleRoomCreated);
    socket.on('room:candidate-joined', handleCandidateJoined);
    socket.on('error:room', handleError);

    return () => {
      socket.off('room:created', handleRoomCreated);
      socket.off('room:candidate-joined', handleCandidateJoined);
      socket.off('error:room', handleError);
    };
  }, [socket, roomId, navigate, setRoom, setUserRole, setInterviewerName, setCandidateJoined, user]);

  const handleCreateRoom = useCallback(() => {
    if (!socket) return;
    socket.emit('interviewer:create-room', { interviewerName: user.name });
  }, [socket, user]);

  const handleCopyCode = useCallback(async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('Copy failed:', err);
    }
  }, [roomCode]);

  const handleLogout = useCallback(() => {
    logout();
    disconnectAll();
    navigate('/');
  }, [logout, navigate]);

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <header className="border-b border-surface-800 bg-surface-950/80 backdrop-blur-lg sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-surface-50">RecruitMonitor</h1>
              <p className="text-xs text-surface-400">Interviewer Dashboard</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-sm text-surface-300">
              Welcome, <span className="text-surface-100 font-medium">{user?.name}</span>
            </span>
            <button onClick={handleLogout} className="btn-secondary text-sm px-4 py-2">
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-lg animate-fade-in">
          {!waiting ? (
            /* Create Room State */
            <div className="text-center">
              <div className="glass-card p-10">
                <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary-500/20 to-primary-700/20 border border-primary-500/20 flex items-center justify-center">
                  <svg className="w-10 h-10 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-surface-50 mb-2">Create Interview Room</h2>
                <p className="text-surface-400 mb-8">
                  Start a new interview session. You'll receive a room code to share with the candidate.
                </p>
                <button onClick={handleCreateRoom} className="btn-primary text-lg px-10 py-4">
                  Create Interview Room
                </button>
              </div>
            </div>
          ) : (
            /* Waiting State */
            <div className="text-center">
              <div className="glass-card p-10">
                <div className="mb-6">
                  <p className="text-sm font-medium text-surface-400 uppercase tracking-wider mb-4">Room Code</p>
                  <div className="room-code inline-block cursor-pointer hover:border-primary-500/40 transition-colors" onClick={handleCopyCode}>
                    {roomCode}
                  </div>
                </div>

                <button
                  onClick={handleCopyCode}
                  className={`mb-8 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                    copied 
                      ? 'bg-success-500/15 text-success-400 border border-success-500/20' 
                      : 'bg-surface-800 text-surface-300 border border-surface-700/50 hover:bg-surface-700'
                  }`}
                >
                  {copied ? (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy Code
                    </>
                  )}
                </button>

                <div className="flex items-center justify-center gap-3 text-surface-400">
                  <div className="dot-pulse">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                  <span className="text-sm">Waiting for candidate to join…</span>
                </div>

                <p className="text-xs text-surface-500 mt-6">
                  Share this code with the candidate. The interview will begin once they join.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
