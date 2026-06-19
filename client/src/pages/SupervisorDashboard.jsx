import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore.js';
import { useMeetingStore } from '../store/useMeetingStore.js';
import { useTranscriptStore } from '../store/useTranscriptStore.js';
import { getSocket, disconnectAll } from '../hooks/useSocket.js';

function StatusBadge({ status }) {
  if (status === 'active') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-success-400 bg-success-400/10 border border-success-400/20 px-2 py-0.5 rounded font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-success-400" />
        Active
      </span>
    );
  }
  if (status === 'interrupted') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-warning-400 bg-warning-400/10 border border-warning-400/20 px-2 py-0.5 rounded font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-warning-400" />
        Interrupted
      </span>
    );
  }
  return null;
}

function MeetingCard({ meeting, onMonitor, isJoining, disabled }) {
  return (
    <div className="glass-card-hover p-5 sm:p-6 animate-slide-up">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-sm text-surface-400">{meeting.id.slice(0, 8)}…</span>
        <StatusBadge status={meeting.status} />
      </div>

      <div className="space-y-2 text-sm mb-5">
        <div className="flex justify-between items-center gap-2">
          <span className="text-surface-500 flex-shrink-0">Interviewer</span>
          <span className="text-surface-200 text-right truncate">
            {meeting.interviewerName || meeting.interviewerId.slice(0, 8) + '…'}
          </span>
        </div>
        <div className="flex justify-between items-center gap-2">
          <span className="text-surface-500 flex-shrink-0">Candidate</span>
          <span className="text-surface-200 text-right truncate">
            {meeting.candidateName || meeting.candidateId.slice(0, 8) + '…'}
          </span>
        </div>
        <div className="flex justify-between items-center gap-2">
          <span className="text-surface-500 flex-shrink-0">Channel</span>
          <span className="font-mono text-xs text-surface-500 text-right truncate">
            {meeting.agoraChannel.slice(0, 12)}…
          </span>
        </div>
      </div>

      {/* Monitor button — full width on mobile (already w-full) */}
      <button
        onClick={onMonitor}
        disabled={disabled}
        className="btn-primary w-full text-sm py-2 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isJoining ? (
          <>
            <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Joining…
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            Monitor
          </>
        )}
      </button>
    </div>
  );
}

export default function SupervisorDashboard() {
  const navigate         = useNavigate();
  const user             = useAuthStore((s) => s.user);
  const logout           = useAuthStore((s) => s.logout);
  const setMeetingJoined = useMeetingStore((s) => s.setMeetingJoined);
  const setInitialData   = useTranscriptStore((s) => s.setInitialData);

  const [meetings,    setMeetings]    = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [joiningId,   setJoiningId]   = useState(null);
  const [error,       setError]       = useState('');

  useEffect(() => {
    const socket = getSocket('supervisor');

    const subscribeActiveMeetings = () => {
      socket.emit('subscribe_active_meetings', (ack) => {
        if (ack.ok) setMeetings(ack.data.meetings);
      });
    };

    const onConnect    = () => { setIsConnected(true); subscribeActiveMeetings(); };
    const onDisconnect = () => setIsConnected(false);

    const onMeetingStatus = ({ meetingId, status }) => {
      setMeetings((prev) => {
        if (status === 'ended') return prev.filter((m) => m.id !== meetingId);
        const exists = prev.some((m) => m.id === meetingId);
        if (!exists) {
          if (status === 'active' || status === 'interrupted') {
            socket.emit('subscribe_active_meetings', (ack) => {
              if (ack.ok) setMeetings(ack.data.meetings);
            });
          }
          return prev;
        }
        return prev.map((m) => m.id === meetingId ? { ...m, status } : m);
      });
    };

    socket.on('connect',        onConnect);
    socket.on('disconnect',     onDisconnect);
    socket.on('meeting_status', onMeetingStatus);

    subscribeActiveMeetings();

    return () => {
      socket.off('connect',        onConnect);
      socket.off('disconnect',     onDisconnect);
      socket.off('meeting_status', onMeetingStatus);
    };
  }, []);

  const handleMonitor = useCallback((meeting) => {
    if (joiningId) return;
    const socket = getSocket('supervisor');
    setJoiningId(meeting.id);
    setError('');

    socket.emit('join_room', { meetingId: meeting.id }, (ack) => {
      if (!ack.ok) {
        setError(ack.error || 'Failed to join the meeting.');
        setJoiningId(null);
        return;
      }

      const { agoraToken, agoraChannel, uid, segments, notes, participantUids, activeVideo } = ack.data;

      if (segments != null || notes != null) {
        setInitialData({ segments: segments ?? [], notes: notes ?? [] });
      }

      setMeetingJoined({
        meetingId:           meeting.id,
        agoraChannel,
        agoraUid:            uid,
        interviewerId:       meeting.interviewerId,
        candidateId:         meeting.candidateId,
        interviewerName:     meeting.interviewerName ?? null,
        candidateName:       meeting.candidateName ?? null,
        interviewerAgoraUid: participantUids?.interviewerUid ?? null,
        candidateAgoraUid:   participantUids?.candidateUid ?? null,
      });

      navigate(`/room/${meeting.id}`, { state: { agoraToken, uid, activeVideo } });
    });
  }, [joiningId, navigate, setMeetingJoined, setInitialData]);

  const handleLogout = useCallback(() => {
    disconnectAll();
    logout();
    navigate('/');
  }, [logout, navigate]);

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <header className="border-b border-surface-800 bg-surface-950 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-md bg-primary-600 flex items-center justify-center flex-shrink-0">
              <svg className="w-4 h-4 sm:w-5 sm:h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-bold text-surface-50 leading-tight">RecruitMonitor</h1>
              <p className="text-xs text-surface-500 hidden sm:block">
                Supervisor Dashboard · Showing {user?.language ? user.language.charAt(0).toUpperCase() + user.language.slice(1) : 'English'} rooms
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-success-400' : 'bg-surface-600 animate-pulse'}`} />
              <span className="text-xs text-surface-400 hidden sm:inline">
                {isConnected ? 'Connected' : 'Connecting…'}
              </span>
            </div>
            {/* User name — hidden on mobile */}
            <span className="hidden sm:inline text-sm font-medium text-surface-100">{user?.name}</span>
            <button onClick={handleLogout} className="btn-secondary text-sm px-3 sm:px-4 py-1.5 sm:py-2">
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-surface-50">Active Interviews</h2>
            <p className="text-sm text-surface-400 mt-0.5">
              {meetings.length === 0
                ? 'No active interviews'
                : `${meetings.length} interview${meetings.length === 1 ? '' : 's'} in progress`}
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-surface-500">
            <div className="w-1.5 h-1.5 rounded-full bg-success-400" />
            Live
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 flex items-center gap-3 px-3 py-2.5 rounded-md bg-danger-500/10 border border-danger-500/20 text-danger-400 text-sm animate-fade-in">
            <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError('')}
              aria-label="Close"
              className="p-0.5 text-surface-500 hover:text-surface-300 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Meetings grid — 1 col on mobile, 2 on md, 3 on lg */}
        {meetings.length === 0 ? (
          <div className="glass-card p-10 sm:p-16 text-center animate-fade-in">
            <div className="w-14 h-14 mx-auto mb-4 rounded-lg bg-surface-800 border border-surface-700 flex items-center justify-center">
              <svg className="w-7 h-7 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="text-surface-300 font-medium">No active interviews</p>
            <p className="text-surface-500 text-sm mt-1">Interviews will appear here when they start.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5 animate-fade-in">
            {meetings.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                onMonitor={() => handleMonitor(meeting)}
                isJoining={joiningId === meeting.id}
                disabled={joiningId !== null}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
