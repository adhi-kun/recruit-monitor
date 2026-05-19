import { create } from 'zustand';

export const useRoomStore = create((set) => ({
  roomId: null,
  roomCode: null,
  rtcChannelName: null,
  candidateName: null,
  interviewerName: null,
  userRole: null,          // 'interviewer' | 'candidate' | 'supervisor'
  status: 'idle',          // 'idle' | 'waiting' | 'active' | 'ended'
  activeRooms: [],         // supervisor dashboard list

  setRoom: (data) => set({
    roomId: data.roomId,
    roomCode: data.roomCode,
    rtcChannelName: data.rtcChannelName,
    status: data.status || 'waiting'
  }),

  setCandidateJoined: (name) => set({
    candidateName: name,
    status: 'active'
  }),

  setCandidateLeft: () => set({
    candidateName: null,
    status: 'waiting'
  }),

  setUserRole: (role) => set({ userRole: role }),

  setCandidateName: (name) => set({ candidateName: name }),

  setInterviewerName: (name) => set({ interviewerName: name }),

  setActiveRooms: (rooms) => set({ activeRooms: rooms }),

  setStatus: (status) => set({ status }),

  clearRoom: () => set({
    roomId: null,
    roomCode: null,
    rtcChannelName: null,
    candidateName: null,
    interviewerName: null,
    userRole: null,
    status: 'idle',
    activeRooms: []
  })
}));
