import { useState, useRef, useCallback, useEffect } from 'react';
import AgoraRTC from 'agora-rtc-sdk-ng';
import { AGORA_APP_ID } from '../config.js';
import { mediaLog } from '../utils/mediaLogger.js';

AgoraRTC.setLogLevel(3);

export default function useAgora({ role, channelName, username }) {
  const clientRef = useRef(null);
  const localVideoRef = useRef(null);
  const localAudioTrackRef = useRef(null);
  const localVideoTrackRef = useRef(null);
  const remoteUsersRef = useRef([]);
  const joiningRef = useRef(false);
  const mountedRef = useRef(true);
  const recreateAudioTrackRef = useRef(null);

  const [localAudioTrack, setLocalAudioTrack] = useState(null);
  const [localVideoTrack, setLocalVideoTrack] = useState(null);
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [isJoined, setIsJoined] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const publishTrack = useCallback(async (track) => {
    const client = clientRef.current;
    if (!client || !track) return;
    try {
      await client.publish(track);
      mediaLog('info', 'agora track published', { role, channelName, kind: track.trackMediaType });
    } catch (err) {
      if (!String(err?.message || '').includes('already published')) {
        mediaLog('warn', 'agora publish failed', { role, channelName, reason: err.message });
      }
    }
  }, [channelName, role]);

  const updateRemoteUsers = useCallback(() => {
    const visible = remoteUsersRef.current.filter((u) => !String(u.uid).startsWith('_sv_'));
    setRemoteUsers([...visible]);
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
        mediaLog('info', 'agora remote subscribed', { role, channelName, uid: String(user.uid), mediaType });
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
      mediaLog('info', 'agora remote unpublished', { role, channelName, uid: String(user.uid), mediaType });
    });

    client.on('user-left', (user) => {
      remoteUsersRef.current = remoteUsersRef.current.filter((u) => u.uid !== user.uid);
      updateRemoteUsers();
      mediaLog('info', 'agora remote left', { role, channelName, uid: String(user.uid) });
    });

    client.on('connection-state-change', (curState, prevState, reason) => {
      mediaLog('info', 'agora connection state changed', { role, channelName, curState, prevState, reason });
    });
  }, [channelName, role, updateRemoteUsers]);

  const recreateAudioTrack = useCallback(async () => {
    if (role === 'supervisor' || !clientRef.current) return;
    try {
      const nextTrack = await AgoraRTC.createMicrophoneAudioTrack();
      nextTrack.on('track-ended', () => {
        mediaLog('warn', 'agora audio track ended', { role, channelName });
        recreateAudioTrackRef.current?.();
      });
      localAudioTrackRef.current?.close();
      localAudioTrackRef.current = nextTrack;
      setLocalAudioTrack(nextTrack);
      setIsMuted(false);
      await publishTrack(nextTrack);
      mediaLog('info', 'agora audio track recreated', { role, channelName });
    } catch (err) {
      mediaLog('error', 'agora audio track recreate failed', { role, channelName, reason: err.message });
    }
  }, [channelName, publishTrack, role]);

  useEffect(() => {
    recreateAudioTrackRef.current = recreateAudioTrack;
  }, [recreateAudioTrack]);

  const joinChannel = useCallback(async () => {
    if (joiningRef.current || isJoined) return;
    if (!channelName || !username || !AGORA_APP_ID) return;

    joiningRef.current = true;
    setIsConnecting(true);

    try {
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      clientRef.current = client;
      bindClientEvents(client);

      const uid = role === 'supervisor' && !String(username).startsWith('_sv_')
        ? `_sv_${username}`
        : username;
      await client.join(AGORA_APP_ID, channelName, null, uid);
      mediaLog('info', 'agora joined', { role, channelName, uid: String(uid) });

      if (role !== 'supervisor') {
        try {
          const audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
          audioTrack.on('track-ended', () => {
            mediaLog('warn', 'agora audio track ended', { role, channelName });
            recreateAudioTrackRef.current?.();
          });
          localAudioTrackRef.current = audioTrack;
          setLocalAudioTrack(audioTrack);
        } catch (err) {
          mediaLog('warn', 'agora microphone unavailable', { role, channelName, reason: err.message });
        }

        try {
          const videoTrack = await AgoraRTC.createCameraVideoTrack();
          videoTrack.on('track-ended', () => mediaLog('warn', 'agora video track ended', { role, channelName }));
          localVideoTrackRef.current = videoTrack;
          setLocalVideoTrack(videoTrack);
        } catch (err) {
          mediaLog('warn', 'agora camera unavailable', { role, channelName, reason: err.message });
        }

        const tracks = [localAudioTrackRef.current, localVideoTrackRef.current].filter(Boolean);
        if (tracks.length > 0) await client.publish(tracks);
        mediaLog('info', 'agora local tracks ready', {
          role,
          channelName,
          hasAudio: !!localAudioTrackRef.current,
          hasVideo: !!localVideoTrackRef.current,
        });
      }

      if (!mountedRef.current) return;
      setIsJoined(true);
    } catch (err) {
      mediaLog('error', 'agora join failed', { role, channelName, reason: err.message });
    } finally {
      joiningRef.current = false;
      if (mountedRef.current) setIsConnecting(false);
    }
  }, [bindClientEvents, channelName, isJoined, role, username]);

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
    clientRef.current = null;
    localAudioTrackRef.current = null;
    localVideoTrackRef.current = null;
    remoteUsersRef.current = [];
    setLocalAudioTrack(null);
    setLocalVideoTrack(null);
    setRemoteUsers([]);
    setIsJoined(false);
    setIsMuted(false);
    setIsCameraOff(false);
  }, [channelName, role]);

  const toggleMute = useCallback(async () => {
    const track = localAudioTrackRef.current;
    if (!track) return;
    const nextMuted = !isMuted;
    try {
      if (typeof track.setMuted === 'function') {
        await track.setMuted(nextMuted);
      } else {
        await track.setEnabled(!nextMuted);
      }
      setIsMuted(nextMuted);
      mediaLog('info', 'agora audio mute toggled', { role, channelName, muted: nextMuted });
    } catch (err) {
      mediaLog('warn', 'agora audio mute toggle failed', { role, channelName, reason: err.message });
    }
  }, [channelName, isMuted, role]);

  const toggleCamera = useCallback(async () => {
    const track = localVideoTrackRef.current;
    if (!track) return;
    const nextOff = !isCameraOff;
    try {
      if (typeof track.setMuted === 'function') {
        await track.setMuted(nextOff);
      } else {
        await track.setEnabled(!nextOff);
      }
      setIsCameraOff(nextOff);
      mediaLog('info', 'agora camera toggled', { role, channelName, cameraOff: nextOff });
    } catch (err) {
      mediaLog('warn', 'agora camera toggle failed', { role, channelName, reason: err.message });
    }
  }, [channelName, isCameraOff, role]);

  useEffect(() => {
    if (channelName && username && !isJoined && !isConnecting) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      joinChannel();
    }
  }, [channelName, username]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      leaveChannel();
    };
  }, [leaveChannel]);

  return {
    localVideoRef,
    localVideoTrack,
    remoteUsers,
    localAudioTrack,
    isJoined,
    isConnecting,
    isMuted,
    isCameraOff,
    toggleMute,
    toggleCamera,
    leaveChannel,
    joinChannel,
  };
}
