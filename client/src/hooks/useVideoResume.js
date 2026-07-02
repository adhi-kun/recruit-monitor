import { useState, useRef, useCallback, useEffect } from 'react';
import { API_URL } from '../config.js';
import { tokenStorage } from '../utils/tokenStorage.js';

const SEEK_DEBOUNCE_MS = 300;

export default function useVideoResume({
  socket,
  meetingId,
  role,
  candidateAgoraUid,
  candidateName,
  interviewerName,
  videoRef,
  syncingRef,
  sharedVideo,
}) {
  const mediaRecorderRef      = useRef(null);
  const chunksRef             = useRef([]);
  const seekDebounceRef       = useRef(null);
  const recordingIntervalRef  = useRef(null);

  const [isRecording,           setIsRecording]           = useState(false);
  const [isProcessingRecording, setIsProcessingRecording] = useState(false);
  const [recordingSeconds,      setRecordingSeconds]      = useState(0);

  // ── Upload ────────────────────────────────────────────────────────────

  const uploadVideo = useCallback(async (file) => {
    const token = tokenStorage.get();

    const urlRes = await fetch(`${API_URL}/meetings/${meetingId}/videos/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ filename: file.name, contentType: file.type }),
    });
    if (!urlRes.ok) {
      const body = await urlRes.json().catch(() => ({}));
      if (body.code === 'VIDEO_APPROVED_LOCKED') {
        throw new Error("This candidate's video has been approved. No further uploads are allowed.");
      }
      throw new Error(body.error ?? 'Failed to get upload URL');
    }
    const { uploadUrl, storagePath } = await urlRes.json();

    // Upload directly to Supabase Storage via signed URL
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!uploadRes.ok) throw new Error('Upload to storage failed');

    const saveRes = await fetch(`${API_URL}/meetings/${meetingId}/videos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        storagePath,
        type:            role === 'candidate' ? 'candidate_upload' : 'interviewer_recording',
        candidateName:   candidateName ?? 'Unknown',
        interviewerName: interviewerName,
      }),
    });
    if (!saveRes.ok) {
      const body = await saveRes.json().catch(() => ({}));
      if (body.code === 'VIDEO_APPROVED_LOCKED') {
        throw new Error("This candidate's video has been approved. No further uploads are allowed.");
      }
      throw new Error(body.error ?? 'Failed to save video metadata');
    }
    const { videoId } = await saveRes.json();
    return videoId;
  }, [meetingId, role, candidateName, interviewerName]);

  // ── Share ─────────────────────────────────────────────────────────────

  const shareVideo = useCallback((videoId) => {
    if (!socket || !meetingId) return;
    socket.emit('share_video', { meetingId, videoId });
  }, [socket, meetingId]);

  // ── Recording ─────────────────────────────────────────────────────────

  const startRecording = useCallback((remoteUsers) => {
    const candidateUser = remoteUsers.find((u) => String(u.uid) === String(candidateAgoraUid));
    if (!candidateUser) return;

    const tracks = [];
    if (candidateUser.videoTrack) tracks.push(candidateUser.videoTrack.getMediaStreamTrack());
    if (candidateUser.audioTrack) tracks.push(candidateUser.audioTrack.getMediaStreamTrack());
    if (tracks.length === 0) return;

    const stream   = new MediaStream(tracks);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.start(1000);
    setRecordingSeconds(0);
    recordingIntervalRef.current = setInterval(() => {
      setRecordingSeconds((s) => s + 1);
    }, 1000);
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
  }, [candidateAgoraUid]);

  const stopRecording = useCallback(() => {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        reject(new Error('No active recording'));
        return;
      }

      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: 'video/webm' });
          const file = new File([blob], `recording-${Date.now()}.webm`, { type: 'video/webm' });
          const videoId = await uploadVideo(file);
          resolve(videoId);
        } catch (err) {
          reject(err);
        } finally {
          mediaRecorderRef.current = null;
          setIsProcessingRecording(false);
        }
      };

      recorder.stop();
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
      setIsRecording(false);
      setIsProcessingRecording(true);
    });
  }, [uploadVideo]);

  // ── Recording interval cleanup on unmount ─────────────────────────────
  useEffect(() => {
    return () => { clearInterval(recordingIntervalRef.current); };
  }, []);

  // ── Local video event emission ────────────────────────────────────────
  // Attaches after sharedVideo is set (video element is mounted by then)

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !socket || !sharedVideo) return;

    const { videoId } = sharedVideo;

    const onPlay = () => {
      if (syncingRef.current) return;
      socket.emit('video_play', { meetingId, videoId, currentTime: video.currentTime });
    };

    const onPause = () => {
      if (syncingRef.current) return;
      socket.emit('video_pause', { meetingId, videoId, currentTime: video.currentTime });
    };

    const onSeeked = () => {
      if (syncingRef.current) return;
      clearTimeout(seekDebounceRef.current);
      seekDebounceRef.current = setTimeout(() => {
        socket.emit('video_seek', { meetingId, videoId, currentTime: video.currentTime });
      }, SEEK_DEBOUNCE_MS);
    };

    video.addEventListener('play',   onPlay);
    video.addEventListener('pause',  onPause);
    video.addEventListener('seeked', onSeeked);

    return () => {
      video.removeEventListener('play',   onPlay);
      video.removeEventListener('pause',  onPause);
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(seekDebounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, meetingId, sharedVideo]); // videoRef and syncingRef are stable refs — intentionally excluded

  return {
    uploadVideo,
    shareVideo,
    startRecording,
    stopRecording,
    isRecording,
    isProcessingRecording,
    recordingSeconds,
  };
}
