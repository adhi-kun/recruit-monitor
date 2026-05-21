import { create } from 'zustand';

export const useTranscriptStore = create((set) => ({
  text: '',
  partialText: '',
  transcriptionUnavailable: false,

  setText: (text) => set({ text }),
  setPartialText: (partialText) => set({ partialText }),
  setTranscriptionUnavailable: (v) => set({ transcriptionUnavailable: v }),
  clearText: () => set({ text: '', partialText: '', transcriptionUnavailable: false }),
}));
