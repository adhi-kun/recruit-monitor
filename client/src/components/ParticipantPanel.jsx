import React from 'react';

export default function ParticipantPanel({ interviewerName, candidateName }) {
  return (
    <div className="glass-card p-4">
      <h3 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-3">Participants</h3>
      <div className="space-y-3">
        {/* Interviewer */}
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-success-400" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-surface-200 truncate">{interviewerName || 'Interviewer'}</p>
            <p className="text-xs text-surface-500">Interviewer</p>
          </div>
        </div>

        {/* Candidate */}
        <div className="flex items-center gap-3">
          {candidateName ? (
            <div className="w-2 h-2 rounded-full bg-success-400" />
          ) : (
            <div className="w-2 h-2 rounded-full bg-surface-600 animate-pulse" />
          )}
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-medium truncate ${candidateName ? 'text-surface-200' : 'text-surface-500 italic'}`}>
              {candidateName || 'Waiting for candidate…'}
            </p>
            <p className="text-xs text-surface-500">Candidate</p>
          </div>
        </div>

        {/* Supervisor is NEVER shown here */}
      </div>
    </div>
  );
}
