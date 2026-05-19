import React, { useState, useEffect } from 'react';

export default function ActiveRoomCard({ room, onMonitor }) {
  const [elapsed, setElapsed] = useState('');

  useEffect(() => {
    const calcElapsed = () => {
      const diff = Date.now() - new Date(room.startedAt).getTime();
      const hrs = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setElapsed(
        `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
      );
    };
    calcElapsed();
    const interval = setInterval(calcElapsed, 1000);
    return () => clearInterval(interval);
  }, [room.startedAt]);

  const startTime = new Date(room.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="glass-card-hover p-6 animate-slide-up">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono font-bold text-lg text-primary-400 tracking-wider">{room.roomCode}</span>
        <span className={room.status === 'active' ? 'status-active' : 'status-waiting'}>
          <span className={`w-1.5 h-1.5 rounded-full ${room.status === 'active' ? 'bg-success-400' : 'bg-warning-400'}`} />
          {room.status === 'active' ? 'Active' : 'Waiting'}
        </span>
      </div>

      <div className="space-y-2.5 text-sm mb-5">
        <div className="flex justify-between">
          <span className="text-surface-400">Interviewer</span>
          <span className="text-surface-200 font-medium">{room.interviewerName}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-surface-400">Candidate</span>
          <span className={room.candidateName ? 'text-surface-200 font-medium' : 'text-surface-500 italic'}>
            {room.candidateName || 'Waiting…'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-surface-400">Duration</span>
          <span className="text-surface-200 font-mono">{elapsed}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-surface-400">Started</span>
          <span className="text-surface-200">{startTime}</span>
        </div>
      </div>

      <button
        onClick={onMonitor}
        disabled={room.isMonitored}
        className={room.isMonitored ? 'btn-secondary w-full opacity-50 cursor-not-allowed' : 'btn-primary w-full'}
      >
        {room.isMonitored ? 'Already Monitored' : 'Monitor Room'}
      </button>
    </div>
  );
}
