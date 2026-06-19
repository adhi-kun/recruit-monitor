import { useEffect, useState, useCallback, useRef, useMemo, startTransition } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore.js';
import { useMeetingStore } from '../store/useMeetingStore.js';
import { useTranscriptStore } from '../store/useTranscriptStore.js';
import { getSocket, getAttachedMeeting, clearAttachedMeeting } from '../hooks/useSocket.js';
import { API_URL } from '../config.js';
import { tokenStorage } from '../utils/tokenStorage.js';
import useAgora from '../hooks/useAgora.js';
import useTranscript from '../hooks/useTranscript.js';
import VideoGrid from '../components/VideoGrid.jsx';
import TranscriptBox from '../components/TranscriptBox.jsx';
import NotesPanel from '../components/NotesPanel.jsx';
import HistoryPanel from '../components/HistoryPanel.jsx';
import RoomControls from '../components/RoomControls.jsx';
import ParticipantPanel from '../components/ParticipantPanel.jsx';
import VideoResumePanel from '../components/VideoResumePanel.jsx';
import ApproveVideoModal from '../components/ApproveVideoModal.jsx';

// ── Mobile helpers ─────────────────────────────────────────────────────

function useMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}

// Overlapping initials shown in the top-right corner of the mobile video.
function MobileAvatarStack({ interviewerName, candidateName }) {
  const names = [interviewerName, candidateName].filter(Boolean);
  if (names.length === 0) return null;
  return (
    <div className="absolute top-2 right-2 flex -space-x-2 z-10 pointer-events-none">
      {names.slice(0, 3).map((name, i) => (
        <div
          key={i}
          className="w-7 h-7 rounded-full bg-surface-800 border-2 border-surface-900 flex items-center justify-center"
        >
          <span className="text-[10px] font-semibold text-surface-300">
            {name.charAt(0).toUpperCase()}
          </span>
        </div>
      ))}
    </div>
  );
}

// SVG icon for each tab in the mobile bottom bar (icon-only, no label).
function TabIcon({ id }) {
  const cls = 'w-5 h-5';
  if (id === 'transcript') return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
  if (id === 'notes') return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
  if (id === 'video') return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
  if (id === 'history') return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
  return null;
}

// Module-level component — must NOT be defined inside InterviewRoom to avoid
// recreating it on every render (which resets child state).
function PanelContent({
  activeTab, historyOpened, socket, effectiveMeetingId,
  role, remoteUsers, candidateName, interviewerName, candidateAgoraUid, candidateId,
  sharedVideo, onClearSharedVideo, videoRef, syncingRef, activeVideo, onApproveClick,
}) {
  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      {activeTab === 'transcript' && (
        <TranscriptBox
          socket={socket}
          meetingId={effectiveMeetingId}
          readOnly={role === 'supervisor'}
        />
      )}
      {activeTab === 'notes' && (
        <NotesPanel
          socket={role !== 'supervisor' ? socket : null}
          meetingId={effectiveMeetingId}
        />
      )}
      {activeTab === 'video' && (
        <VideoResumePanel
          socket={socket}
          meetingId={effectiveMeetingId}
          role={role}
          remoteUsers={remoteUsers}
          candidateName={candidateName}
          interviewerName={interviewerName}
          candidateAgoraUid={candidateAgoraUid}
          sharedVideo={sharedVideo}
          onClearSharedVideo={onClearSharedVideo}
          videoRef={videoRef}
          syncingRef={syncingRef}
          activeVideo={activeVideo}
          onApproveClick={onApproveClick}
        />
      )}
      {/* History stays mounted after first open to preserve scroll position */}
      <div className={activeTab !== 'history' ? 'hidden' : 'h-full overflow-y-auto'}>
        {historyOpened && <HistoryPanel candidateId={candidateId} role={role} />}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

const GRACE_SECONDS = 30;

export default function InterviewRoom() {
  const navigate              = useNavigate();
  const { state: locState }   = useLocation();
  const { roomId: meetingIdParam } = useParams();

  const user  = useAuthStore((s) => s.user);
  const role  = user?.role ?? 'candidate';

  const meetingId           = useMeetingStore((s) => s.meetingId);
  const agoraChannel        = useMeetingStore((s) => s.agoraChannel);
  const agoraUid            = useMeetingStore((s) => s.agoraUid);
  const candidateId         = useMeetingStore((s) => s.candidateId);
  const interviewerName     = useMeetingStore((s) => s.interviewerName);
  const candidateName       = useMeetingStore((s) => s.candidateName);
  const interviewerAgoraUid = useMeetingStore((s) => s.interviewerAgoraUid);
  const candidateAgoraUid   = useMeetingStore((s) => s.candidateAgoraUid);
  const clearMeeting        = useMeetingStore((s) => s.clearMeeting);
  const setMeetingJoined    = useMeetingStore((s) => s.setMeetingJoined);
  const applyMeetingStatus  = useMeetingStore((s) => s.applyMeetingStatus);
  const activeVideo         = useMeetingStore((s) => s.activeVideo);
  const setActiveVideo      = useMeetingStore((s) => s.setActiveVideo);

  const addSegment             = useTranscriptStore((s) => s.addSegment);
  const setTranscriptionFailed = useTranscriptStore((s) => s.setTranscriptionFailed);
  const addNote                = useTranscriptStore((s) => s.addNote);
  const updateNote             = useTranscriptStore((s) => s.updateNote);
  const removeNote             = useTranscriptStore((s) => s.removeNote);
  const mergeCatchupData       = useTranscriptStore((s) => s.mergeCatchupData);
  const clearTranscript        = useTranscriptStore((s) => s.clearTranscript);

  const [historyOpened,        setHistoryOpened]        = useState(false);
  const [terminated,           setTerminated]           = useState(false);
  const [terminatedCountdown,  setTerminatedCountdown]  = useState(5);
  const [interrupted,          setInterrupted]          = useState(false);
  const [interruptedCountdown, setInterruptedCountdown] = useState(GRACE_SECONDS);
  const [connectionLost,       setConnectionLost]       = useState(false);
  const [activeTab,            setActiveTab]            = useState('transcript');
  const [agoraCredentials,     setAgoraCredentials]     = useState(locState ?? null);
  const [sharedVideo,          setSharedVideo]          = useState(null); // { videoId, signedUrl, sharedBy } | null
  const [approveModalOpen,     setApproveModalOpen]     = useState(false);
  const [approveTargetVideoId, setApproveTargetVideoId] = useState(null);
  const [approveError,         setApproveError]         = useState(null);

  const interruptedTimerRef = useRef(null);
  const videoRef            = useRef(null);   // shared with VideoResumePanel for sync handlers
  const syncingRef          = useRef(false);  // prevents emit feedback when applying remote sync
  const isMobile            = useMobile();

  const socketRole = role === 'interviewer' ? 'interviewer'
                   : role === 'supervisor'  ? 'supervisor'
                   : 'candidate';
  // getSocket creates a socket.io connection on first call — side effect that
  // must not repeat on every render. useState lazy initializer runs exactly once.
  const [socket] = useState(() => getSocket(socketRole));

  const {
    localVideoRef, localVideoTrack, localAudioTrack, remoteUsers,
    isMuted, isCameraOff,
    joinChannel, leaveChannel, toggleMute, toggleCamera,
  } = useAgora({ role, channelName: agoraChannel });

  // Transcript pipeline — candidate only
  useTranscript({
    localAudioTrack: role === 'candidate' ? localAudioTrack : null,
    socket:          role === 'candidate' ? socket : null,
    enabled:         role === 'candidate',
    paused:          isMuted,
  });

  const effectiveMeetingId = meetingId ?? meetingIdParam;

  const videoBadge = sharedVideo && activeTab !== 'video';
  const tabs = role === 'supervisor'
    ? [{ id: 'transcript', label: 'Transcript' }, { id: 'notes', label: 'Notes' }, { id: 'video', label: 'Video', badge: videoBadge }, { id: 'history', label: 'History' }]
    : [{ id: 'transcript', label: 'Transcript' }, { id: 'video', label: 'Video', badge: videoBadge }, { id: 'history', label: 'History' }];

  const uidToName = useMemo(() => {
    const map = {};
    // Exclude null/undefined UIDs — coercing null to the string 'null' produces a key
    // that never matches a numeric Agora UID and pollutes the lookup table.
    if (agoraUid != null)            map[agoraUid]            = user?.name ?? 'You';
    if (interviewerAgoraUid != null) map[interviewerAgoraUid] = interviewerName ?? 'Interviewer';
    if (candidateAgoraUid != null)   map[candidateAgoraUid]   = candidateName ?? 'Candidate';
    return map;
  }, [agoraUid, interviewerAgoraUid, candidateAgoraUid, interviewerName, candidateName, user?.name]);

  // Shared by desktop tab bar and mobile bottom bar
  const switchTab = useCallback((tabId) => {
    setActiveTab(tabId);
    if (tabId === 'history') setHistoryOpened(true);
  }, []);

  const hydrateMeeting = useCallback(async (attachedPayload = null) => {
    const targetMeetingId = attachedPayload?.meetingId ?? effectiveMeetingId;
    if (!targetMeetingId) return;

    const token = tokenStorage.get();
    if (!token) return;

    // activeVideo is self-contained in the cached meeting_attached payload — restore it
    // here so a video approved/shared on a prior meeting still shows up on this one even
    // when the real meeting_attached event fired before InterviewRoom ever mounted
    // (e.g. while still on the waiting room / dashboard page).
    if (attachedPayload?.activeVideo) {
      startTransition(() => {
        setActiveVideo(attachedPayload.activeVideo);
        setSharedVideo(attachedPayload.activeVideo);
      });
    }

    try {
      const lastSeq = useTranscriptStore
        .getState()
        .segments
        .reduce((max, seg) => Math.max(max, seg.seq ?? 0), 0);
      const [meetingRes, transcriptRes, notesRes] = await Promise.all([
        fetch(`${API_URL}/meetings/${targetMeetingId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/meetings/${targetMeetingId}/transcript?afterSeq=${lastSeq}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/meetings/${targetMeetingId}/notes`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (!meetingRes.ok) return;
      const { meeting } = await meetingRes.json();
      const transcriptBody = transcriptRes.ok ? await transcriptRes.json() : { segments: [] };
      const notesBody = notesRes.ok ? await notesRes.json() : { notes: [] };

      startTransition(() => {
        setMeetingJoined({
          meetingId:           meeting.id,
          agoraChannel:        attachedPayload?.agoraChannel ?? meeting.agoraChannel,
          agoraUid:            attachedPayload?.uid ?? null,
          candidateId:         meeting.candidateId,
          interviewerId:       meeting.interviewerId,
          interviewerName:     meeting.interviewerName ?? null,
          candidateName:       meeting.candidateName ?? null,
          interviewerAgoraUid: attachedPayload?.participantUids?.interviewerUid ?? undefined,
          candidateAgoraUid:   attachedPayload?.participantUids?.candidateUid   ?? undefined,
        });
        applyMeetingStatus({ meetingId: meeting.id, status: attachedPayload?.status ?? meeting.status });
        mergeCatchupData({ segments: transcriptBody.segments ?? [], notes: notesBody.notes ?? [] });
      });

      // If we hydrated into an already-ended meeting (e.g. grace fired while disconnected),
      // trigger the terminated UI path so the 5s countdown and redirect run — the
      // meeting_status socket event was missed while offline so setTerminated is never
      // called by onMeetingStatus for this case.
      if ((attachedPayload?.status ?? meeting.status) === 'ended') {
        clearAttachedMeeting(socketRole);
        setTerminated(true);
        return;
      }

      if (attachedPayload?.agoraToken && attachedPayload?.uid != null) {
        setAgoraCredentials({ agoraToken: attachedPayload.agoraToken, uid: attachedPayload.uid });
      }
    } catch (err) {
      console.warn('Meeting hydration failed:', err);
    }
  }, [effectiveMeetingId, socketRole, setMeetingJoined, applyMeetingStatus, mergeCatchupData, setActiveVideo, setSharedVideo]);

  // Join Agora when credentials are available — joinChannel's internal guard prevents double-join
  useEffect(() => {
    const { agoraToken, uid, initialMicEnabled, initialCamEnabled } = agoraCredentials ?? {};
    if (agoraToken && uid != null && agoraChannel) {
      joinChannel(agoraToken, uid, {
        initialMicEnabled: initialMicEnabled ?? true,
        initialCamEnabled: initialCamEnabled ?? true,
      });
    }
  }, [agoraCredentials, agoraChannel, joinChannel]);

  // Socket events — all logic identical to before
  useEffect(() => {
    if (!socket) return;

    const onConnect    = () => {
      setConnectionLost(false);
      hydrateMeeting(getAttachedMeeting(socketRole));
    };
    const onDisconnect = () => setConnectionLost(true);

    const onMeetingAttached = (payload) => {
      if (payload.activeVideo) {
        startTransition(() => {
          setActiveVideo(payload.activeVideo);
          setSharedVideo(payload.activeVideo);
        });
      }
      hydrateMeeting(payload);
    };

    const onMeetingStatus = ({ meetingId: mid, status, interviewerName: evtInterviewerName, participantUids }) => {
      startTransition(() => applyMeetingStatus({ meetingId: mid, status }));

      if (status === 'ended') {
        clearInterval(interruptedTimerRef.current);
        startTransition(() => { setInterrupted(false); setTerminated(true); });
        clearAttachedMeeting(socketRole);
      } else if (status === 'interrupted') {
        clearInterval(interruptedTimerRef.current);
        startTransition(() => { setInterrupted(true); setInterruptedCountdown(GRACE_SECONDS); });
        interruptedTimerRef.current = setInterval(() => {
          setInterruptedCountdown((c) => {
            if (c <= 1) {
              clearInterval(interruptedTimerRef.current);
              setInterrupted(false);
              setTerminated(true);
              return 0;
            }
            return c - 1;
          });
        }, 1000);
      } else if (status === 'active') {
        clearInterval(interruptedTimerRef.current);
        if (evtInterviewerName != null || participantUids?.interviewerUid != null) {
          const cur = useMeetingStore.getState();
          startTransition(() => setMeetingJoined({
            meetingId:           cur.meetingId,
            agoraChannel:        cur.agoraChannel,
            agoraUid:            cur.agoraUid,
            candidateId:         cur.candidateId,
            interviewerId:       cur.interviewerId,
            interviewerName:     evtInterviewerName,
            interviewerAgoraUid: participantUids?.interviewerUid,
            candidateAgoraUid:   participantUids?.candidateUid,
          }));
        }
        startTransition(() => setInterrupted(false));
      }
    };

    const onTranscriptSegment = (segment) => { addSegment(segment); };
    const onTranscriptError   = ()          => { setTranscriptionFailed(true); };
    const onNoteAdded         = (note)                         => addNote(note);
    const onNoteUpdated       = ({ noteId, body, updatedAt }) => updateNote({ noteId, body, updatedAt });
    const onNoteDeleted       = ({ noteId })                   => removeNote(noteId);

    const onVideoAvailable = (payload) => {
      startTransition(() => {
        setSharedVideo(payload);
        // A newly shared video is by definition newer than whatever was active —
        // reflect it now so a reload picks the correct video as "active".
        setActiveVideo({
          videoId:      payload.videoId,
          signedUrl:    payload.signedUrl,
          isApproved:   false,
          uploaderRole: null,
          uploaderName: null,
          uploadedAt:   new Date().toISOString(),
          approvedBy:   null,
          approvedAt:   null,
        });
      });
    };

    const onVideoApproved = ({ videoId, approvedAt, approvedByName }) => {
      startTransition(() => {
        const cur = useMeetingStore.getState().activeVideo;
        setActiveVideo({ ...(cur ?? {}), videoId, isApproved: true, approvedAt, approvedBy: approvedByName });
      });
    };
    const onPlaySync = ({ currentTime }) => {
      const video = videoRef.current;
      if (!video) return;
      syncingRef.current = true;
      video.currentTime = currentTime;
      video.play().catch(() => {}).finally(() => {
        Promise.resolve().then(() => { syncingRef.current = false; });
      });
    };
    const onPauseSync = ({ currentTime }) => {
      const video = videoRef.current;
      if (!video) return;
      syncingRef.current = true;
      video.currentTime = currentTime;
      video.pause();
      syncingRef.current = false;
    };
    const onSeekSync = ({ currentTime }) => {
      const video = videoRef.current;
      if (!video) return;
      syncingRef.current = true;
      video.currentTime = currentTime;
      const clear = () => { syncingRef.current = false; video.removeEventListener('seeked', clear); };
      video.addEventListener('seeked', clear, { once: true });
    };

    socket.on('connect',            onConnect);
    socket.on('disconnect',         onDisconnect);
    socket.on('meeting_attached',   onMeetingAttached);
    socket.on('meeting_status',     onMeetingStatus);
    socket.on('transcript_segment', onTranscriptSegment);
    socket.on('transcript_error',   onTranscriptError);
    socket.on('note_added',         onNoteAdded);
    socket.on('note_updated',       onNoteUpdated);
    socket.on('note_deleted',       onNoteDeleted);
    socket.on('video_available',    onVideoAvailable);
    socket.on('video_approved',     onVideoApproved);
    socket.on('video_play_sync',    onPlaySync);
    socket.on('video_pause_sync',   onPauseSync);
    socket.on('video_seek_sync',    onSeekSync);

    queueMicrotask(() => hydrateMeeting(getAttachedMeeting(socketRole)));

    return () => {
      socket.off('connect',            onConnect);
      socket.off('disconnect',         onDisconnect);
      socket.off('meeting_attached',   onMeetingAttached);
      socket.off('meeting_status',     onMeetingStatus);
      socket.off('transcript_segment', onTranscriptSegment);
      socket.off('transcript_error',   onTranscriptError);
      socket.off('note_added',         onNoteAdded);
      socket.off('note_updated',       onNoteUpdated);
      socket.off('note_deleted',       onNoteDeleted);
      socket.off('video_available',    onVideoAvailable);
      socket.off('video_approved',     onVideoApproved);
      socket.off('video_play_sync',    onPlaySync);
      socket.off('video_pause_sync',   onPauseSync);
      socket.off('video_seek_sync',    onSeekSync);
    };
  }, [socket, role, socketRole, applyMeetingStatus, setMeetingJoined, addSegment, setTranscriptionFailed, addNote, updateNote, removeNote, hydrateMeeting, setActiveVideo]);

  // Terminated countdown → redirect
  useEffect(() => {
    if (!terminated) return;
    const timer = setInterval(() => {
      setTerminatedCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          clearMeeting();
          clearTranscript();
          if (role === 'interviewer') {
            clearAttachedMeeting('interviewer');
            navigate('/interviewer');
          } else if (role === 'supervisor') navigate('/supervisor');
          else {
            clearAttachedMeeting('candidate');
            navigate('/candidate');
          }
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [terminated, role, navigate, clearMeeting, clearTranscript]);

  // Clear interrupted timer on unmount
  useEffect(() => () => clearInterval(interruptedTimerRef.current), []);

  const handleEndCall = useCallback(async () => {
    if (role === 'interviewer') {
      socket.emit('end_meeting', { meetingId: meetingId ?? meetingIdParam, reason: 'interviewer_ended' });
    }
    await leaveChannel();
    clearMeeting();
    clearTranscript();
    if (role === 'interviewer') {
      clearAttachedMeeting('interviewer');
      navigate('/interviewer');
    } else if (role === 'supervisor') navigate('/supervisor');
    else navigate('/candidate');
  }, [role, socket, meetingId, meetingIdParam, leaveChannel, clearMeeting, clearTranscript, navigate]);

  const handleApproveClick = useCallback((videoId) => {
    setApproveError(null);
    setApproveTargetVideoId(videoId);
    setApproveModalOpen(true);
  }, []);

  const handleApproveConfirm = useCallback(() => {
    if (!socket || !approveTargetVideoId) return;
    const targetMeetingId = meetingId ?? meetingIdParam;
    socket.emit('approve_video', { meetingId: targetMeetingId, videoId: approveTargetVideoId }, (ack) => {
      if (ack.ok) {
        setApproveModalOpen(false);
        setApproveTargetVideoId(null);
      } else {
        setApproveError(ack.error ?? 'Failed to approve video');
      }
    });
  }, [socket, meetingId, meetingIdParam, approveTargetVideoId]);

  const handleApproveCancel = useCallback(() => {
    setApproveModalOpen(false);
    setApproveTargetVideoId(null);
    setApproveError(null);
  }, []);

  // Convenience: resolved names for the current role
  const resolvedInterviewerName = interviewerName ?? (role === 'interviewer' ? user?.name : null);
  const resolvedCandidateName   = candidateName   ?? (role === 'candidate'   ? user?.name : null);

  // Props forwarded to PanelContent in both layout branches
  const panelContentProps = {
    activeTab,
    historyOpened,
    socket,
    effectiveMeetingId,
    role,
    remoteUsers,
    candidateName:      resolvedCandidateName,
    interviewerName:    resolvedInterviewerName,
    candidateAgoraUid,
    candidateId,
    sharedVideo,
    onClearSharedVideo: () => setSharedVideo(null),
    videoRef,
    syncingRef,
    activeVideo,
    onApproveClick: handleApproveClick,
  };

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden">

      {/* Connection lost banner */}
      {connectionLost && (
        <div className="bg-warning-500/20 border-b border-warning-500/30 px-4 py-2 text-center flex-shrink-0">
          <span className="text-warning-400 text-sm font-medium">
            Connection lost — reconnecting…
          </span>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────
          Mobile:  logo icon + connection status dot only (no text)
          Desktop: logo + title + role badge + meeting ID              */}
      <header className="border-b border-surface-800 bg-surface-950 z-30 flex-shrink-0">
        <div className="max-w-full px-4 md:px-6 py-2 md:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 md:gap-3">
            <div className="w-7 h-7 md:w-8 md:h-8 rounded-md bg-primary-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="hidden md:block text-base font-bold text-surface-50">RecruitMonitor</h1>
          </div>
          <div className="flex items-center gap-2 md:gap-4">
            {/* Status dot — always visible */}
            <div className={`w-2 h-2 rounded-full ${connectionLost ? 'bg-warning-400 animate-pulse' : 'bg-success-400'}`} />
            <div className="hidden md:flex items-center gap-4">
              {role === 'supervisor' && (
                <span className="text-xs bg-primary-500/10 text-primary-400 px-2.5 py-1 rounded font-medium">
                  Monitoring
                </span>
              )}
              <span className="text-xs bg-surface-800 border border-surface-700 text-surface-300 px-2 py-0.5 rounded">
                {(user?.language ?? 'english').charAt(0).toUpperCase() + (user?.language ?? 'english').slice(1)}
              </span>
              {effectiveMeetingId && (
                <span className="font-mono text-xs text-surface-500">
                  {effectiveMeetingId.slice(0, 8)}…
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Mobile layout (< md) ───────────────────────────────────────
          Stack: video (aspect-video) → panel content (flex-1) → bottom bar (h-14).
          Bottom bar is flex-shrink-0 and in-flow — no position:fixed needed,
          so the panel content area never hides behind it.              */}
      {isMobile ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

          {/* Video — full width, 16:9 aspect ratio */}
          <div className="relative aspect-video w-full overflow-hidden flex-shrink-0 max-h-[40vh]">
            <VideoGrid
              role={role}
              localVideoRef={localVideoRef}
              localVideoTrack={localVideoTrack}
              remoteUsers={remoteUsers}
              isMuted={isMuted}
              isCameraOff={isCameraOff}
              localName={user?.name ?? 'You'}
              uidToName={uidToName}
            />
            {/* Participant initials — replaces the full ParticipantPanel on mobile */}
            <MobileAvatarStack
              interviewerName={resolvedInterviewerName}
              candidateName={resolvedCandidateName}
            />
          </div>

          {/* Active panel content — fills remaining height */}
          <div className="flex-1 min-h-0 overflow-hidden bg-surface-900/50">
            <PanelContent {...panelContentProps} />
          </div>

          {/* Bottom bar: [mic/cam] | [tab icons — centered] | [end call] */}
          <div className="flex-shrink-0 h-14 bg-surface-950 border-t border-surface-800 flex items-center px-2 gap-1 z-20">

            {/* Left: mic + camera (hidden for supervisor) */}
            <div className="flex items-center gap-1">
              {role !== 'supervisor' && (
                <>
                  <button
                    onClick={toggleMute}
                    title={isMuted ? 'Unmute' : 'Mute'}
                    className={`btn-icon p-2.5 min-h-[44px] min-w-[44px] ${
                      isMuted ? 'bg-danger-500/15 border-danger-500/30 text-danger-400' : ''
                    }`}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      {isMuted ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 19L5 5m14 0v6a3 3 0 01-2.12 2.88M12 19a7 7 0 01-7-7V9m14 0v2m-3.5 7.5L12 19m0 0v2.25M7.5 19h9" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                      )}
                    </svg>
                  </button>
                  <button
                    onClick={toggleCamera}
                    title={isCameraOff ? 'Turn Camera On' : 'Turn Camera Off'}
                    className={`btn-icon p-2.5 min-h-[44px] min-w-[44px] ${
                      isCameraOff ? 'bg-danger-500/15 border-danger-500/30 text-danger-400' : ''
                    }`}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      {isCameraOff ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M12 18.75H4.5a2.25 2.25 0 01-2.25-2.25V7.5A2.25 2.25 0 014.5 5.25h7.5M3 3l18 18" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                      )}
                    </svg>
                  </button>
                </>
              )}
            </div>

            {/* Center: tab icon buttons — active tab highlighted text-primary-400 */}
            <div className="flex-1 flex items-center justify-center gap-0.5">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => switchTab(tab.id)}
                  title={tab.label}
                  className={`p-2 rounded-md transition-colors min-h-[44px] min-w-[36px] flex items-center justify-center ${
                    activeTab === tab.id ? 'text-primary-400' : 'text-surface-500 hover:text-surface-300'
                  }`}
                >
                  <span className="relative">
                    <TabIcon id={tab.id} />
                    {tab.badge && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary-400" />
                    )}
                  </span>
                </button>
              ))}
            </div>

            {/* Right: End Call — compact, solid danger-500, icon-only */}
            <button
              onClick={handleEndCall}
              title="End Call"
              className="p-2.5 rounded-md bg-danger-500 hover:bg-danger-600 text-white transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M1.5 4.5l21 15" />
              </svg>
            </button>
          </div>
        </div>

      ) : (
        /* ── Desktop layout — 60/40 split, unchanged ─────────────────── */
        <>
          <div className="flex-1 min-h-0 flex overflow-hidden">

            {/* Video + participant panel — 60% */}
            <div className="flex-[3] flex flex-col p-4 gap-4 min-h-0 overflow-hidden">
              <div className="w-full aspect-video rounded-lg overflow-hidden flex-shrink-0">
                <VideoGrid
                  role={role}
                  localVideoRef={localVideoRef}
                  localVideoTrack={localVideoTrack}
                  remoteUsers={remoteUsers}
                  isMuted={isMuted}
                  isCameraOff={isCameraOff}
                  localName={user?.name ?? 'You'}
                  uidToName={uidToName}
                />
              </div>
              <ParticipantPanel
                interviewerName={resolvedInterviewerName}
                candidateName={resolvedCandidateName}
              />
            </div>

            {/* Right sidebar — 40% */}
            <div className="flex-[2] border-l border-surface-800 bg-surface-900/50 flex flex-col min-h-0 overflow-hidden">
              {/* Tab bar */}
              <div className="flex border-b border-surface-700/50 flex-shrink-0">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => switchTab(tab.id)}
                    className={`flex-1 py-2.5 text-sm font-medium transition-colors border-b-2 ${
                      activeTab === tab.id
                        ? 'text-primary-400 border-primary-400'
                        : 'text-surface-400 border-transparent hover:text-surface-200'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {tab.label}
                      {tab.badge && <span className="w-2 h-2 rounded-full bg-primary-400 flex-shrink-0" />}
                    </span>
                  </button>
                ))}
              </div>

              <PanelContent {...panelContentProps} />
            </div>
          </div>

          <RoomControls
            role={role}
            isMuted={isMuted}
            isCameraOff={isCameraOff}
            onToggleMute={toggleMute}
            onToggleCamera={toggleCamera}
            onEndCall={handleEndCall}
          />
        </>
      )}

      {/* ── Interrupted overlay ─────────────────────────────────────── */}
      {interrupted && !terminated && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-surface-950/70 animate-fade-in">
          <div className="glass-card p-8 text-center max-w-sm w-full mx-4">
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-warning-500/10 border border-warning-500/20 flex items-center justify-center">
              <svg className="w-7 h-7 text-warning-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-surface-50 mb-2">Connection Interrupted</h2>
            <p className="text-surface-400 text-sm mb-4">
              A participant lost connection. Waiting for them to reconnect…
            </p>
            <p className="text-surface-500 text-sm">
              Session ends in{' '}
              <span className="text-warning-400 font-mono font-semibold">{interruptedCountdown}s</span>
            </p>
          </div>
        </div>
      )}

      {/* ── Terminated overlay ──────────────────────────────────────── */}
      {terminated && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-950/80 animate-fade-in">
          <div className="glass-card p-10 text-center max-w-md w-full mx-4 animate-slide-up">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-danger-500/10 border border-danger-500/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-danger-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M1.5 4.5l21 15" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-surface-50 mb-2">Interview Ended</h2>
            <p className="text-surface-400 mb-6">This session has concluded.</p>
            <p className="text-surface-500 text-sm">
              Redirecting in {terminatedCountdown} second{terminatedCountdown !== 1 ? 's' : ''}…
            </p>
            {/* Dots drain as time runs out: 5 lit → 0 lit */}
            <div className="flex justify-center gap-1 mt-4">
              {Array.from({ length: 5 }, (_, i) => (
                <div
                  key={i}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    i < terminatedCountdown ? 'bg-primary-400' : 'bg-surface-600'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Approve video confirmation modal ────────────────────────── */}
      <ApproveVideoModal
        isOpen={approveModalOpen}
        onConfirm={handleApproveConfirm}
        onCancel={handleApproveCancel}
      />
      {approveModalOpen && approveError && (
        <div className="fixed bottom-4 right-4 z-50 bg-danger-500/15 border border-danger-500/30 text-danger-400 text-sm px-4 py-3 rounded-lg shadow-lg max-w-sm">
          {approveError}
        </div>
      )}
    </div>
  );
}
