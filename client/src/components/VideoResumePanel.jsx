import { useState, useRef, useCallback } from 'react';
import useVideoResume from '../hooks/useVideoResume.js';

const MAX_FILE_BYTES = 120 * 1024 * 1024; // 120 MB

export default function VideoResumePanel({
  socket,
  meetingId,
  role,
  remoteUsers,
  candidateName,
  interviewerName,
  candidateAgoraUid,
  sharedVideo,
  onClearSharedVideo,
  videoRef,
  syncingRef,
}) {
  const {
    uploadVideo,
    shareVideo,
    startRecording,
    stopRecording,
    isRecording,
  } = useVideoResume({ socket, meetingId, role, candidateAgoraUid, candidateName, interviewerName, videoRef, syncingRef, sharedVideo });

  const fileInputRef = useRef(null);

  const [localVideoId,  setLocalVideoId]  = useState(null);
  const [uploading,     setUploading]     = useState(false);
  const [uploadError,   setUploadError]   = useState(null);
  const [recordError,   setRecordError]   = useState(null);

  const handleFileSelect = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so selecting the same file again triggers onChange
    e.target.value = '';

    if (file.size > MAX_FILE_BYTES) {
      setUploadError('File must be under 120 MB');
      return;
    }

    setUploading(true);
    setUploadError(null);
    try {
      const videoId = await uploadVideo(file);
      setLocalVideoId(videoId);
    } catch (err) {
      setUploadError(err.message ?? 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [uploadVideo]);

  const handleStopRecording = useCallback(async () => {
    setRecordError(null);
    try {
      const videoId = await stopRecording();
      setLocalVideoId(videoId);
    } catch (err) {
      setRecordError(err.message ?? 'Recording upload failed');
    }
  }, [stopRecording]);

  const handleShare = useCallback(() => {
    if (!localVideoId) return;
    shareVideo(localVideoId);
    setLocalVideoId(null);
  }, [localVideoId, shareVideo]);

  const isSupervisor = role === 'supervisor';
  const isInterviewer = role === 'interviewer';

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">

      {/* ── Shared video player ──────────────────────────────────────── */}
      {sharedVideo && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-surface-400 font-medium uppercase tracking-wider">
              Shared video
            </p>
            <button
              onClick={onClearSharedVideo}
              className="text-surface-500 hover:text-surface-300 transition-colors"
              title="Dismiss video"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <video
            ref={videoRef}
            src={sharedVideo.signedUrl}
            controls
            className="w-full rounded-xl bg-surface-900"
            style={{ maxHeight: '240px' }}
          />
          <p className="text-xs text-surface-500">
            Shared by participant
          </p>
        </div>
      )}

      {/* ── Upload / record controls (candidate + interviewer) ───────── */}
      {!isSupervisor && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-surface-400 font-medium uppercase tracking-wider">
            {isInterviewer ? 'Record or share video' : 'Share video resume'}
          </p>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Upload section */}
          {!uploading && !localVideoId && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-2.5 px-4 rounded-xl border border-surface-700 text-surface-300 text-sm hover:border-primary-500/50 hover:text-primary-400 transition-colors text-left flex items-center gap-2"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              Upload video file
            </button>
          )}

          {uploading && (
            <div className="flex items-center gap-2 py-2.5 px-4 rounded-xl bg-surface-800/50">
              <svg className="w-4 h-4 text-primary-400 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              <span className="text-sm text-surface-300">Uploading…</span>
            </div>
          )}

          {localVideoId && !uploading && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 py-2 px-3 rounded-xl bg-primary-500/10 border border-primary-500/20">
                <svg className="w-4 h-4 text-primary-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-primary-300">Video ready</span>
              </div>
              <button
                onClick={handleShare}
                className="w-full py-2.5 px-4 rounded-xl bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium transition-colors"
              >
                {isInterviewer ? 'Share with candidate' : 'Share with interviewer'}
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-2 px-4 rounded-xl text-surface-400 hover:text-surface-200 text-xs transition-colors text-center"
              >
                Upload a different file
              </button>
            </div>
          )}

          {uploadError && (
            <p className="text-sm text-danger-400 bg-danger-500/10 px-3 py-2 rounded-lg">
              {uploadError}
            </p>
          )}

          {/* Recording controls (interviewer only) */}
          {isInterviewer && (
            <div className="border-t border-surface-700/50 pt-3 flex flex-col gap-2">
              <p className="text-xs text-surface-500">Or record live candidate video</p>

              {!isRecording ? (
                <button
                  onClick={() => {
                    setRecordError(null);
                    startRecording(remoteUsers);
                  }}
                  disabled={isRecording}
                  className="w-full py-2.5 px-4 rounded-xl border border-surface-700 text-surface-300 text-sm hover:border-danger-500/50 hover:text-danger-400 transition-colors flex items-center gap-2"
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-danger-500 flex-shrink-0" />
                  Record candidate
                </button>
              ) : (
                <button
                  onClick={handleStopRecording}
                  className="w-full py-2.5 px-4 rounded-xl border border-danger-500/50 bg-danger-500/10 text-danger-400 text-sm font-medium flex items-center gap-2 transition-colors hover:bg-danger-500/20"
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-danger-500 animate-pulse flex-shrink-0" />
                  Stop recording
                </button>
              )}

              {recordError && (
                <p className="text-sm text-danger-400 bg-danger-500/10 px-3 py-2 rounded-lg">
                  {recordError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Empty state for supervisor with no shared video */}
      {isSupervisor && !sharedVideo && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-surface-500 text-sm text-center">
            No video has been shared yet.
          </p>
        </div>
      )}

      {/* Empty state for candidate/interviewer with no shared video and no local video */}
      {!isSupervisor && !sharedVideo && !localVideoId && !uploading && (
        <p className="text-xs text-surface-600 text-center">
          Video will appear here once shared.
        </p>
      )}
    </div>
  );
}
