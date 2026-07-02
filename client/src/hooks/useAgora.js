import { useState, useRef, useCallback, useEffect, startTransition } from 'react';
import AgoraRTC from 'agora-rtc-sdk-ng';
import { AGORA_APP_ID } from '../config.js';
import { mediaLog } from '../utils/mediaLogger.js';

AgoraRTC.setLogLevel(3);

export default function useAgora({ role, channelName }) {
  const clientRef          = useRef(null);
  const localVideoRef      = useRef(null);
  const localAudioTrackRef = useRef(null);
  const localVideoTrackRef = useRef(null);
  const remoteUsersRef     = useRef([]);
  const joiningRef         = useRef(false);
  const mountedRef         = useRef(false);
  const localUidRef        = useRef(null);   // integer UID assigned by server
  const recreateAudioTrackRef = useRef(null);

  const [localAudioTrack, setLocalAudioTrack] = useState(null);
  const [localVideoTrack, setLocalVideoTrack] = useState(null);
  const [remoteUsers,     setRemoteUsers]     = useState([]);
  const [isJoined,        setIsJoined]        = useState(false);
  const [isConnecting,    setIsConnecting]    = useState(false);
  const [isMuted,         setIsMuted]         = useState(false);
  const [isCameraOff,     setIsCameraOff]     = useState(false);

  // ── AudioContext resume ───────────────────────────────────────────────
  // Browsers auto-suspend AudioContext on tab switch or window blur.
  // We attempt resume via the SDK's shared context before re-enabling tracks.

  const resumeAudioContext = useCallback(async () => {
    try {
      const ctx = AgoraRTC.getAudioContext?.();
      if (ctx && ctx.state === 'suspended') {
        await ctx.resume();
        mediaLog('info', 'agora AudioContext resumed', { role });
      }
    } catch (err) {
      mediaLog('warn', 'agora AudioContext resume failed', { role, reason: err.message });
    }
  }, [role]);

  // Register the three resume call sites once on mount; clean up on unmount.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resumeAudioContext();
    };
    const onFocus = () => resumeAudioContext();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Remote user helpers ───────────────────────────────────────────────

  const updateRemoteUsers = useCallback(() => {
    // Filter out our own UID in case it surfaces (should not happen, but defensive).
    // No _sv_ prefix logic — supervisors hold subscriber-only tokens and never
    // publish tracks, so they never trigger user-published on other clients.
    const visible = remoteUsersRef.current.filter(
      (u) => u.uid !== localUidRef.current,
    );
    // startTransition defers this non-urgent update so it can't land during
    // React 19's concurrent render cycle and trigger "update during render".
    startTransition(() => setRemoteUsers([...visible]));
  }, []);

  const bindClientEvents = useCallback((client) => {
    client.removeAllListeners();
    remoteUsersRef.current = [];

    client.on('user-published', async (user, mediaType) => {
      try {
        await client.subscribe(user, mediaType);
        const existing = remoteUsersRef.current.find((u) => u.uid === user.uid);
        if (existing) {
          Object.assign(existing, user);
        } else {
          remoteUsersRef.current.push(user);
        }
        if (mediaType === 'audio' && user.audioTrack) user.audioTrack.play();
        updateRemoteUsers();
        mediaLog('info', 'agora remote subscribed', { role, channelName, uid: user.uid, mediaType });
      } catch (err) {
        mediaLog('warn', 'agora remote subscribe failed', { role, channelName, mediaType, reason: err.message });
      }
    });

    client.on('user-unpublished', (user, mediaType) => {
      const existing = remoteUsersRef.current.find((u) => u.uid === user.uid);
      if (existing) {
        if (mediaType === 'audio') existing.audioTrack = null;
        if (mediaType === 'video') existing.videoTrack = null;
      }
      updateRemoteUsers();
      mediaLog('info', 'agora remote unpublished', { role, channelName, uid: user.uid, mediaType });
    });

    client.on('user-left', (user) => {
      remoteUsersRef.current = remoteUsersRef.current.filter((u) => u.uid !== user.uid);
      updateRemoteUsers();
      mediaLog('info', 'agora remote left', { role, channelName, uid: user.uid });
    });

    client.on('connection-state-change', (curState, prevState, reason) => {
      mediaLog('info', 'agora connection state changed', { role, channelName, curState, prevState, reason });
      if (curState === 'DISCONNECTED' && prevState === 'CONNECTED') {
        mediaLog('warn', 'agora unexpected disconnect', { role, channelName, reason });
      }
    });
  }, [channelName, role, updateRemoteUsers]);

  // ── Audio track recreation ────────────────────────────────────────────

  const recreateAudioTrack = useCallback(async () => {
    if (role === 'supervisor' || !clientRef.current) return;
    try {
      const nextTrack = await AgoraRTC.createMicrophoneAudioTrack();
      if (!mountedRef.current || !clientRef.current) {
        nextTrack.close();
        mediaLog('warn', 'agora audio recreate aborted (unmounted)', { role, channelName });
        return;
      }
      nextTrack.on('track-ended', () => recreateAudioTrackRef.current?.());
      localAudioTrackRef.current?.close();
      localAudioTrackRef.current = nextTrack;
      setLocalAudioTrack(nextTrack);
      setIsMuted(false);
      await clientRef.current.publish(nextTrack);
      mediaLog('info', 'agora audio track recreated', { role, channelName });
    } catch (err) {
      mediaLog('error', 'agora audio recreate failed', { role, channelName, reason: err.message });
    }
  }, [channelName, role]);

  useEffect(() => {
    recreateAudioTrackRef.current = recreateAudioTrack;
  }, [recreateAudioTrack]);

  // ── joinChannel ───────────────────────────────────────────────────────
  // Called explicitly by the component after receiving the server join ack.
  // agoraToken and uid are server-assigned — not derived client-side.

  const joinChannel = useCallback(async (agoraToken, uid, { initialMicEnabled = true, initialCamEnabled = true } = {}) => {
    if (joiningRef.current || isJoined) return;
    if (!channelName || !agoraToken || uid == null || !AGORA_APP_ID) return;

    joiningRef.current = true;
    setIsConnecting(true);

    try {
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      clientRef.current = client;
      bindClientEvents(client);

      await client.join(AGORA_APP_ID, channelName, agoraToken, uid);
      if (!mountedRef.current) return;

      localUidRef.current = uid;
      mediaLog('info', 'agora joined', { role, channelName, uid });

      if (role !== 'supervisor') {
        // Audio track
        try {
          const audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
          if (!mountedRef.current) { audioTrack.close(); return; }
          audioTrack.on('track-ended', () => {
            mediaLog('warn', 'agora audio track ended', { role, channelName });
            recreateAudioTrackRef.current?.();
          });
          if (!initialMicEnabled) {
            await audioTrack.setEnabled(false);
            setIsMuted(true);
          }
          localAudioTrackRef.current = audioTrack;
          setLocalAudioTrack(audioTrack);
        } catch (err) {
          mediaLog('warn', 'agora microphone unavailable', { role, channelName, reason: err.message });
        }

        if (!mountedRef.current) return;

        // Video track
        try {
          const videoTrack = await AgoraRTC.createCameraVideoTrack({ facingMode: 'user' });
          if (!mountedRef.current) { videoTrack.close(); return; }
          videoTrack.on('track-ended', () =>
            mediaLog('warn', 'agora video track ended', { role, channelName }),
          );
          if (!initialCamEnabled) {
            await videoTrack.setEnabled(false);
            setIsCameraOff(true);
          }
          localVideoTrackRef.current = videoTrack;
          setLocalVideoTrack(videoTrack);
        } catch (err) {
          mediaLog('warn', 'agora camera unavailable', { role, channelName, reason: err.message });
        }

        if (!mountedRef.current) return;

        const tracks = [localAudioTrackRef.current, localVideoTrackRef.current].filter(Boolean);
        if (tracks.length > 0) {
          await client.publish(tracks);
          if (!mountedRef.current) return;
        }

        mediaLog('info', 'agora local tracks ready', {
          role,
          channelName,
          hasAudio: !!localAudioTrackRef.current,
          hasVideo: !!localVideoTrackRef.current,
        });
      }

      setIsJoined(true);
    } catch (err) {
      mediaLog('error', 'agora join failed', { role, channelName, reason: err.message });
    } finally {
      joiningRef.current = false;
      if (mountedRef.current) setIsConnecting(false);
    }
  }, [bindClientEvents, channelName, isJoined, role]);

  // ── leaveChannel ──────────────────────────────────────────────────────

  const leaveChannel = useCallback(async () => {
    try {
      localAudioTrackRef.current?.stop();
      localAudioTrackRef.current?.close();
      localVideoTrackRef.current?.stop();
      localVideoTrackRef.current?.close();
      if (clientRef.current) {
        await clientRef.current.leave();
        clientRef.current.removeAllListeners();
      }
      mediaLog('info', 'agora left', { role, channelName });
    } catch (err) {
      mediaLog('warn', 'agora leave failed', { role, channelName, reason: err.message });
    }
    clientRef.current          = null;
    localAudioTrackRef.current = null;
    localVideoTrackRef.current = null;
    localUidRef.current        = null;
    remoteUsersRef.current     = [];
    setLocalAudioTrack(null);
    setLocalVideoTrack(null);
    setRemoteUsers([]);
    setIsJoined(false);
    setIsMuted(false);
    setIsCameraOff(false);
  }, [channelName, role]);

  // ── toggleMute ────────────────────────────────────────────────────────

  const toggleMute = useCallback(async () => {
    const track = localAudioTrackRef.current;
    if (!track) return;
    const nextMuted = !isMuted;
    try {
      if (!nextMuted) {
        // Resume AudioContext before re-enabling — third call site.
        await resumeAudioContext();
      }
      await track.setEnabled(!nextMuted);
      setIsMuted(nextMuted);
      mediaLog('info', 'agora audio mute toggled', { role, channelName, muted: nextMuted });
    } catch (err) {
      mediaLog('warn', 'agora mute toggle failed', { role, channelName, reason: err.message });
    }
  }, [channelName, isMuted, resumeAudioContext, role]);

  // ── toggleCamera ──────────────────────────────────────────────────────

  const toggleCamera = useCallback(async () => {
    const track = localVideoTrackRef.current;
    if (!track || !clientRef.current) return;
    const nextOff = !isCameraOff;
    try {
      await track.setEnabled(!nextOff);
      setIsCameraOff(nextOff);
      mediaLog('info', 'agora camera toggled', { role, channelName, cameraOff: nextOff });
    } catch (err) {
      mediaLog('warn', 'agora camera toggle failed', { role, channelName, reason: err.message });
    }
  }, [channelName, isCameraOff, role]);

  // ── Lifecycle ─────────────────────────────────────────────────────────
  // mountedRef is set once on mount and cleared on unmount.
  // Empty dep array — intentional, this must run exactly once.

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      leaveChannel();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    localVideoRef,
    localVideoTrack,
    localAudioTrack,
    remoteUsers,
    isJoined,
    isConnecting,
    isMuted,
    isCameraOff,
    joinChannel,
    leaveChannel,
    toggleMute,
    toggleCamera,
  };
}
