import React from 'react';

export default function RoomControls({ role, isMuted, isCameraOff, onToggleMute, onToggleCamera, onEndCall }) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-t border-surface-800 bg-surface-950/80 backdrop-blur-lg">
      <div className="flex items-center gap-3">
        {role !== 'supervisor' && (
          <>
            {/* Mute Button */}
            <button
              onClick={onToggleMute}
              className={`btn-icon ${isMuted ? 'bg-danger-500/20 border-danger-500/30 text-danger-400' : ''}`}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                {isMuted ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 19L5 5m14 0v6a3 3 0 01-2.12 2.88M12 19a7 7 0 01-7-7V9m14 0v2m-3.5 7.5L12 19m0 0v2.25M7.5 19h9" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                )}
              </svg>
            </button>

            {/* Camera Button */}
            <button
              onClick={onToggleCamera}
              className={`btn-icon ${isCameraOff ? 'bg-danger-500/20 border-danger-500/30 text-danger-400' : ''}`}
              title={isCameraOff ? 'Turn Camera On' : 'Turn Camera Off'}
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

      {/* End Call */}
      <button onClick={onEndCall} className="btn-danger flex items-center gap-2">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M1.5 4.5l21 15" />
        </svg>
        End Call
      </button>
    </div>
  );
}
