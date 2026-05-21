import { useEffect, useRef } from 'react';

function VideoTile({ user, label, isLocal, videoRef, isMuted, isCameraOff, size = 'large' }) {
  const tileRef = useRef(null);
  const ref = isLocal ? videoRef : tileRef;

  useEffect(() => {
    if (!isLocal && user?.videoTrack && tileRef.current) {
      user.videoTrack.play(tileRef.current);
    }
    return () => {
      if (!isLocal && user?.videoTrack) {
        try { user.videoTrack.stop(); } catch (e) { console.warn(e); }
      }
    };
  }, [user?.videoTrack, isLocal]);

  const sizeClasses = size === 'large'
    ? 'w-full h-full min-h-[300px]'
    : 'w-48 h-36 absolute top-4 right-4 z-10 shadow-2xl';

  const showAvatar = isLocal ? isCameraOff : !user?.videoTrack;
  const initial = label ? label.charAt(0).toUpperCase() : '?';

  return (
    <div className={`video-tile ${sizeClasses}`}>
      {showAvatar ? (
        <div className="w-full h-full flex items-center justify-center bg-surface-800">
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-3xl font-bold text-white">
            {initial}
          </div>
        </div>
      ) : (
        <div ref={ref} className="w-full h-full" />
      )}
      <div className="video-tile-label">
        {isMuted !== undefined && (
          <svg className={`w-4 h-4 ${isMuted ? 'text-danger-400' : 'text-success-400'}`} fill="currentColor" viewBox="0 0 24 24">
            {isMuted ? (
              <path d="M1.5 4.5l21 15m-2.25-4.5a9.75 9.75 0 01-2.599 2.083M12 18.75a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M9 4.51A3.75 3.75 0 0112 3a3.75 3.75 0 013.75 3.75v3.75a3.75 3.75 0 01-.356 1.593" />
            ) : (
              <path d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            )}
          </svg>
        )}
        <span>{label || 'Unknown'}</span>
      </div>
    </div>
  );
}

export default function VideoGrid({ role, localVideoRef, remoteUsers, isMuted, isCameraOff, localName }) {
  if (role === 'supervisor') {
    // Supervisor: two remote tiles, no local
    return (
      <div className="relative w-full h-full flex gap-3">
        {remoteUsers.length > 0 ? (
          <>
            <div className="flex-1">
              <VideoTile user={remoteUsers[0]} label={String(remoteUsers[0]?.uid || 'Participant')} size="large" />
            </div>
            {remoteUsers.length > 1 && (
              <div className="w-64">
                <VideoTile user={remoteUsers[1]} label={String(remoteUsers[1]?.uid || 'Participant')} size="large" />
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-surface-500">
            Waiting for participants…
          </div>
        )}
      </div>
    );
  }

  // Interviewer / Candidate: local small + remote large
  const remoteUser = remoteUsers[0];

  return (
    <div className="relative w-full h-full">
      {/* Remote (large) */}
      {remoteUser ? (
        <VideoTile user={remoteUser} label={String(remoteUser.uid || 'Participant')} size="large" />
      ) : (
        <div className="video-tile w-full h-full min-h-[300px] flex items-center justify-center">
          <div className="text-center">
            <div className="dot-pulse mb-4 justify-center">
              <span></span><span></span><span></span>
            </div>
            <p className="text-surface-400 text-sm">Waiting for the other participant…</p>
          </div>
        </div>
      )}

      {/* Local (small, corner) */}
      <VideoTile
        isLocal
        videoRef={localVideoRef}
        label={localName || 'You'}
        isMuted={isMuted}
        isCameraOff={isCameraOff}
        size="small"
      />
    </div>
  );
}
