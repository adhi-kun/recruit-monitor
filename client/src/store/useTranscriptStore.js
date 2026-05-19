import { create } from 'zustand';

export const useTranscriptStore = create((set) => ({
  text: '',

  setText: (text) => set({ text }),

  clearText: () => set({ text: '' })
}));
