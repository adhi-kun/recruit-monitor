import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useTranscriptStore } from '../store/useTranscriptStore.js';

export default function TranscriptBox({ role, socket, roomId }) {
  const text = useTranscriptStore((s) => s.text);
  const setText = useTranscriptStore((s) => s.setText);
  const containerRef = useRef(null);
  const [isFocused, setIsFocused] = useState(false);
  const debounceRef = useRef(null);

  // Auto-scroll when not editing
  useEffect(() => {
    if (!isFocused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [text, isFocused]);

  // Interviewer onChange with debounced emit
  const handleChange = useCallback((e) => {
    const newText = e.target.value;
    setText(newText); // Optimistic update

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (socket && roomId) {
        socket.emit('transcript:update', { roomId, text: newText });
      }
    }, 500);
  }, [socket, roomId, setText]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700/50">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-sm font-semibold text-surface-200">Transcript</span>
        </div>
        {role === 'interviewer' && (
          <span className="text-xs text-primary-400 bg-primary-500/10 px-2 py-1 rounded-lg">Editable</span>
        )}
        {role === 'candidate' && (
          <span className="text-xs text-surface-400 bg-surface-700/30 px-2 py-1 rounded-lg">Live</span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-hidden">
        {role === 'interviewer' ? (
          <textarea
            ref={containerRef}
            value={text}
            onChange={handleChange}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Transcript will appear here as the candidate speaks…"
            className="w-full h-full bg-transparent text-surface-200 text-sm leading-relaxed 
                       resize-none focus:outline-none placeholder:text-surface-600 font-sans"
          />
        ) : (
          <div
            ref={containerRef}
            className="w-full h-full overflow-y-auto pointer-events-auto select-none"
          >
            {text ? (
              <p className="text-surface-200 text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
            ) : (
              <p className="text-surface-600 text-sm italic">
                {role === 'candidate'
                  ? 'Your speech will appear here as you speak…'
                  : 'Transcript will appear here when the candidate speaks…'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
