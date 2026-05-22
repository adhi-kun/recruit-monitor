import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore.js';
import { useRoomStore } from '../store/useRoomStore.js';
import { useTranscriptStore } from '../store/useTranscriptStore.js';
import { getSocket } from '../hooks/useSocket.js';
import useAgora from '../hooks/useAgora.js';
import useTranscript from '../hooks/useTranscript.js';
import VideoGrid from '../components/VideoGrid.jsx';
import TranscriptBox from '../components/TranscriptBox.jsx';
import RoomControls from '../components/RoomControls.jsx';
import ParticipantPanel from '../components/ParticipantPanel.jsx';

export default function InterviewRoom() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const roomId = useRoomStore((s) => s.roomId);
  const roomCode = useRoomStore((s) => s.roomCode);
  const rtcChannelName = useRoomStore((s) => s.rtcChannelName);
  const candidateName = useRoomStore((s) => s.candidateName);
  const interviewerName = useRoomStore((s) => s.interviewerName);
  const userRole = useRoomStore((s) => s.userRole);
  const setCandidateJoined = useRoomStore((s) => s.setCandidateJoined);
  const setCandidateLeft = useRoomStore((s) => s.setCandidateLeft);
  const clearRoom = useRoomStore((s) => s.clearRoom);
  const clearText = useTranscriptStore((s) => s.clearText);
  const setText = useTranscriptStore((s) => s.setText);
  const setPartialText = useTranscriptStore((s) => s.setPartialText);
  const setTranscriptionUnavailable = useTranscriptStore((s) => s.setTranscriptionUnavailable);
  const transcriptionUnavailable = useTranscriptStore((s) => s.transcriptionUnavailable);

  const [terminated, setTerminated] = useState(null);
  const [countdown, setCountdown] = useState(3);
  const [connectionLost, setConnectionLost] = useState(false);

  // Fix 1 — interviewer focus tracking ref
  const interviewerHasFocusRef = useRef(false);
  // Sequence number tracking for out-of-order event rejection
  const lastSeqRef = useRef(0);

  const role = user?.role ?? userRole;

  // Determine socket namespace and Agora username
  const socketRole = role === 'interviewer' ? 'interviewer' : role === 'supervisor' ? 'supervisor' : 'candidate';
  const socket = getSocket(socketRole);

  const agoraUsername = role === 'supervisor'
    ? `_sv_${user?.name || 'Supervisor'}`
    : role === 'interviewer'
    ? (user?.name || 'Interviewer')
    : (useRoomStore.getState().candidateName || 'Candidate');

  const localName = role === 'candidate'
    ? useRoomStore.getState().candidateName
    : user?.name;

  // Agora hook
  const {
    localVideoRef, localVideoTrack, remoteUsers, localAudioTrack,
    isMuted, isCameraOff,
    toggleMute, toggleCamera, leaveChannel
  } = useAgora({
    role,
    channelName: rtcChannelName,
    username: agoraUsername
  });

  // Transcript hook — candidate only
  useTranscript({
    localAudioTrack: role === 'candidate' ? localAudioTrack : null,
    socket: role === 'candidate' ? socket : null,
    roomId,
    enabled: role === 'candidate',
    paused: isMuted
  });

  // Socket event handling
  useEffect(() => {
    if (!socket) return;

    const handleTerminated = ({ reason }) => {
      setTerminated(reason);
    };

    const handleTranscriptBroadcast = ({ text }) => {
      if (role === 'interviewer' && interviewerHasFocusRef.current) return; // Fix 1
      setText(text);
    };

    const handleTranscriptPartial = ({ text, sequenceNumber }) => {
      if (role === 'candidate') return; // candidate handles via useTranscript
      if (sequenceNumber != null && sequenceNumber <= lastSeqRef.current) return;
      setPartialText(text || '');
    };

    const handleTranscriptFinal = ({ fullText, sequenceNumber }) => {
      if (role === 'candidate') return;
      if (role === 'interviewer' && interviewerHasFocusRef.current) return; // Fix 1
      if (sequenceNumber != null && sequenceNumber < lastSeqRef.current) return;
      lastSeqRef.current = sequenceNumber || 0;
      setText(fullText);
      setPartialText('');
      setTranscriptionUnavailable(false);
    };

    const handleTranscriptError = ({ message }) => {
      if (role === 'candidate') return;
      console.warn('Transcription error:', message);
      setTranscriptionUnavailable(true);
    };

    const handleCandidateJoined = ({ candidateName: name }) => {
      setCandidateJoined(name);
    };

    const handleCandidateLeftEvt = () => {
      setCandidateLeft();
    };

    socket.on('room:terminated', handleTerminated);
    socket.on('transcript:broadcast', handleTranscriptBroadcast);
    socket.on('transcript:partial', handleTranscriptPartial);
    socket.on('transcript:final', handleTranscriptFinal);
    socket.on('transcript:error', handleTranscriptError);

    if (role === 'interviewer') {
      socket.on('room:candidate-joined', handleCandidateJoined);
      socket.on('room:candidate-left', handleCandidateLeftEvt);
    }

    // Connection lost banner
    const handleConnect = () => setConnectionLost(false);
    const handleDisconnect = () => setConnectionLost(true);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('room:terminated', handleTerminated);
      socket.off('transcript:broadcast', handleTranscriptBroadcast);
      socket.off('transcript:partial', handleTranscriptPartial);
      socket.off('transcript:final', handleTranscriptFinal);
      socket.off('transcript:error', handleTranscriptError);
      if (role === 'interviewer') {
        socket.off('room:candidate-joined', handleCandidateJoined);
        socket.off('room:candidate-left', handleCandidateLeftEvt);
      }
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, [socket, role, setText, setPartialText, setTranscriptionUnavailable, setCandidateJoined, setCandidateLeft]);

  // Terminated countdown & redirect
  useEffect(() => {
    if (!terminated) return;
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          clearRoom();
          clearText();
          if (role === 'interviewer') navigate('/interviewer');
          else if (role === 'supervisor') navigate('/supervisor');
          else navigate('/join');
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [terminated, role, navigate, clearRoom, clearText]);

  // End call handler
  const handleEndCall = useCallback(async () => {
    if (role === 'interviewer') {
      socket.emit('interviewer:leave');
    } else if (role === 'candidate') {
      socket.emit('candidate:leave');
    } else if (role === 'supervisor') {
      socket.emit('supervisor:leave-room');
    }
    await leaveChannel();
    clearRoom();
    clearText();
    if (role === 'interviewer') navigate('/interviewer');
    else if (role === 'supervisor') navigate('/supervisor');
    else navigate('/join');
  }, [role, socket, leaveChannel, clearRoom, clearText, navigate]);

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden">
      {/* Connection lost banner */}
      {connectionLost && (
        <div className="bg-warning-500/20 border-b border-warning-500/30 px-4 py-2 text-center">
          <span className="text-warning-400 text-sm font-medium">
            ⚠ Connection lost — reconnecting…
          </span>
        </div>
      )}

      {/* Transcript unavailable banner */}
      {transcriptionUnavailable && role !== 'candidate' && (
        <div className="bg-warning-500/20 border-b border-warning-500/30 px-4 py-2 text-center">
          <span className="text-warning-400 text-sm font-medium">
            ⚠ Transcription unavailable
          </span>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-surface-800 bg-surface-950/80 backdrop-blur-lg z-30 flex-shrink-0">
        <div className="max-w-full px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-base font-bold text-surface-50">RecruitMonitor</h1>
          </div>
          <div className="flex items-center gap-4">
            {role === 'supervisor' && (
              <span className="text-xs bg-primary-500/10 text-primary-400 px-3 py-1 rounded-lg font-medium">
                Monitoring Mode
              </span>
            )}
            {roomCode && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-800/60 border border-surface-700/50">
                <span className="text-xs text-surface-400">Room</span>
                <span className="font-mono font-bold text-primary-400 text-sm tracking-wider">{roomCode}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video area — 60% */}
        <div className="flex-[3] flex flex-col p-4 gap-4 overflow-hidden">
          <div className="flex-1 rounded-2xl overflow-hidden">
            <VideoGrid
              role={role}
              localVideoRef={localVideoRef}
              localVideoTrack={localVideoTrack}
              remoteUsers={remoteUsers}
              isMuted={isMuted}
              isCameraOff={isCameraOff}
              localName={localName}
            />
          </div>
          {/* Participant Panel below video */}
          <ParticipantPanel
            interviewerName={interviewerName || (role === 'interviewer' ? user?.name : null)}
            candidateName={candidateName}
          />
        </div>

        {/* Transcript area — 40% */}
        <div className="flex-[2] border-l border-surface-800 bg-surface-900/50 flex flex-col overflow-hidden">
          <TranscriptBox
            role={role}
            socket={socket}
            roomId={roomId}
            onFocus={() => { interviewerHasFocusRef.current = true; }}
            onBlur={() => { interviewerHasFocusRef.current = false; }}
          />
        </div>
      </div>

      {/* Controls bar */}
      <RoomControls
        role={role}
        isMuted={isMuted}
        isCameraOff={isCameraOff}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onEndCall={handleEndCall}
      />

      {/* Terminated modal */}
      {terminated && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 backdrop-blur-md animate-fade-in">
          <div className="glass-card p-10 text-center max-w-md animate-slide-up">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-danger-500/10 border border-danger-500/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-danger-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M1.5 4.5l21 15" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-surface-50 mb-2">This interview has ended</h2>
            <p className="text-surface-400 mb-6">Reason: {terminated}</p>
            <p className="text-surface-500 text-sm">Redirecting in {countdown} second{countdown !== 1 ? 's' : ''}…</p>
            <div className="flex justify-center gap-1 mt-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className={`w-2.5 h-2.5 rounded-full transition-colors ${i <= (3 - countdown) ? 'bg-primary-400' : 'bg-surface-600'}`} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
