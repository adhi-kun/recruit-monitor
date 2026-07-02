import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore.js';
import { useMeetingStore } from '../store/useMeetingStore.js';
import { getSocket, disconnectAll } from '../hooks/useSocket.js';

export default function CandidateWaitingRoom() {
  const navigate          = useNavigate();
  const user              = useAuthStore((s) => s.user);
  const logout            = useAuthStore((s) => s.logout);
  const setMeetingJoined  = useMeetingStore((s) => s.setMeetingJoined);

  const videoRef       = useRef(null);
  const streamRef      = useRef(null);
  const micEnabledRef  = useRef(true);
  const camEnabledRef  = useRef(true);

  const [micEnabled,   setMicEnabled]   = useState(true);
  const [camEnabled,   setCamEnabled]   = useState(true);
  const [starting,     setStarting]     = useState(false);
  const [error,        setError]        = useState('');
  const [previewReady, setPreviewReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' } }, audio: true })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setPreviewReady(true);
      })
      .catch(() => {
        if (!cancelled) setPreviewReady(true);
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    const socket = getSocket('candidate');

    const onMeetingAttached = (payload) => {
      if (!payload?.meetingId) return;
      setMeetingJoined({
        meetingId:           payload.meetingId,
        agoraChannel:        payload.agoraChannel,
        agoraUid:            payload.uid,
        candidateId:         payload.candidateId ?? user?.userId ?? null,
        interviewerId:       payload.interviewerId ?? null,
        interviewerAgoraUid: payload.participantUids?.interviewerUid ?? null,
        candidateAgoraUid:   payload.participantUids?.candidateUid ?? null,
      });
      navigate(`/room/${payload.meetingId}`, {
        state: {
          agoraToken:        payload.agoraToken,
          uid:               payload.uid,
          initialMicEnabled: micEnabledRef.current,
          initialCamEnabled: camEnabledRef.current,
        },
      });
    };

    socket.on('meeting_attached', onMeetingAttached);
    return () => { socket.off('meeting_attached', onMeetingAttached); };
  }, [navigate, setMeetingJoined, user?.userId]);

  const toggleMic = useCallback(async () => {
    if (micEnabled) {
      const stream = streamRef.current;
      if (stream) stream.getAudioTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
      micEnabledRef.current = false;
      setMicEnabled(false);
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        const [track] = s.getAudioTracks();
        if (track) {
          if (!streamRef.current) {
            streamRef.current = new MediaStream([track]);
          } else {
            streamRef.current.addTrack(track);
          }
        }
        setError('');
        micEnabledRef.current = true;
        setMicEnabled(true);
      } catch {
        setError('Microphone access was denied. Please check your browser permissions.');
      }
    }
  }, [micEnabled]);

  const toggleCam = useCallback(async () => {
    if (camEnabled) {
      const stream = streamRef.current;
      if (stream) stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
      camEnabledRef.current = false;
      setCamEnabled(false);
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' } } });
        const [track] = s.getVideoTracks();
        if (track) {
          if (!streamRef.current) {
            streamRef.current = new MediaStream([track]);
            if (videoRef.current) videoRef.current.srcObject = streamRef.current;
          } else {
            streamRef.current.addTrack(track);
          }
        }
        setError('');
        camEnabledRef.current = true;
        setCamEnabled(true);
      } catch {
        setError('Camera access was denied. Please check your browser permissions.');
      }
    }
  }, [camEnabled]);

  const handleStart = useCallback(() => {
    if (starting) return;
    setStarting(true);
    setError('');
    const socket = getSocket('candidate');

    const timeout = setTimeout(() => {
      setStarting(false);
      setError('Connection timeout. Please try again.');
    }, 10_000);

    socket.emit('start_session', (ack) => {
      clearTimeout(timeout);
      if (ack.ok) return;
      if (ack.code === 'CONFLICT') {
        setStarting(false);
      } else {
        setError(ack.error || 'Failed to start session. Please try again.');
        setStarting(false);
      }
    });
  }, [starting]);

  const handleLogout = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    disconnectAll();
    logout();
    navigate('/');
  }, [logout, navigate]);

  const toggleBtnBase = 'h-11 min-w-[120px] flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors';

  return (
    <div className="flex-1 flex flex-col sm:items-center sm:justify-center sm:px-4 sm:py-8">
      <div className="w-full sm:max-w-md animate-fade-in">

        {/* Logo + greeting */}
        <div className="text-center px-6 pt-10 pb-6 sm:px-0 sm:pt-0 sm:pb-0 sm:mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-md bg-primary-600 mb-4">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-surface-50 mb-1">
            {user?.name ? `Hi, ${user.name}` : 'Interview Room'}
          </h1>
          <p className="text-sm text-surface-400">{user?.email}</p>
        </div>

        {/* Card — edge-to-edge on mobile; camera preview fills the top */}
        <div className="glass-card rounded-none sm:rounded-lg overflow-hidden">

          {/* Camera preview — full width, aspect-video, no padding, edge-to-edge */}
          <div className="relative aspect-video w-full bg-surface-800">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className={`w-full h-full object-cover ${!camEnabled ? 'invisible' : ''}`}
            />
            {!camEnabled && (
              <div className="absolute inset-0 flex items-center justify-center">
                <svg className="w-12 h-12 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
            )}
          </div>

          {/* Controls below preview */}
          <div className="px-5 sm:px-6 py-5 space-y-4">

            {/* Mic / Cam toggles — h-11 (44px) minimum touch target */}
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={toggleMic}
                className={`${toggleBtnBase} ${
                  micEnabled
                    ? 'bg-surface-700 text-surface-100 hover:bg-surface-600'
                    : 'bg-danger-500/15 text-danger-400 border border-danger-500/30 hover:bg-danger-500/25'
                }`}
              >
                {micEnabled ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                )}
                {micEnabled ? 'Mic on' : 'Mic off'}
              </button>

              <button
                onClick={toggleCam}
                className={`${toggleBtnBase} ${
                  camEnabled
                    ? 'bg-surface-700 text-surface-100 hover:bg-surface-600'
                    : 'bg-danger-500/15 text-danger-400 border border-danger-500/30 hover:bg-danger-500/25'
                }`}
              >
                {camEnabled ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                )}
                {camEnabled ? 'Cam on' : 'Cam off'}
              </button>
            </div>

            {error && (
              <p className="text-danger-400 text-sm text-center">{error}</p>
            )}

            {/* Start button — full width on mobile */}
            <button
              onClick={handleStart}
              disabled={starting || !previewReady}
              className="btn-primary w-full py-3 text-base font-semibold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {starting ? (
                <>
                  <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Starting…
                </>
              ) : (
                'Start Session'
              )}
            </button>
          </div>
        </div>

        {/* Sign out */}
        <div className="text-center px-6 py-5 sm:px-0 sm:mt-5">
          <button
            onClick={handleLogout}
            className="text-surface-500 hover:text-surface-300 text-sm transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
