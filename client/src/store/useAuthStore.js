import { create } from 'zustand';

function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (err) {
    console.warn('Failed to parse JWT:', err);
    return null;
  }
}

export const useAuthStore = create((set) => ({
  user: null,
  token: null,
  isAuthenticated: false,

  login: (user, token) => {
    sessionStorage.setItem('token', token);
    set({ user, token, isAuthenticated: true });
  },

  logout: () => {
    sessionStorage.removeItem('token');
    set({ user: null, token: null, isAuthenticated: false });
  },

  rehydrate: () => {
    const token = sessionStorage.getItem('token');
    if (!token) return;

    const payload = parseJwt(token);
    if (!payload) {
      sessionStorage.removeItem('token');
      return;
    }

    // Check if token is expired
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      sessionStorage.removeItem('token');
      return;
    }

    set({
      user: {
        userId: payload.userId,
        email: payload.email,
        role: payload.role,
        name: payload.name
      },
      token,
      isAuthenticated: true
    });
  }
}));
