import { useState, useRef, useCallback, useEffect } from 'react';
import AgoraRTC from 'agora-rtc-sdk-ng';
import { AGORA_APP_ID } from '../config.js';

AgoraRTC.setLogLevel(3); // Warnings only

export default function useAgora({ role, channelName, username }) {
  const clientRef = useRef(null);
  const localVideoRef = useRef(null);
  const localVideoTrackRef = useRef(null);

  const [localAudioTrack, setLocalAudioTrack] = useState(null);
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [isJoined, setIsJoined] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  // Filter out supervisor UIDs (_sv_ prefix)
  const filterSupervisor = useCallback((users) => {
    return users.filter(u => !String(u.uid).startsWith('_sv_'));
  }, []);

  const joinChannel = useCallback(async () => {
    if (isConnecting || isJoined) return;
    if (!channelName || !username) return;

    setIsConnecting(true);

    try {
      // Create client
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      clientRef.current = client;

      // Remove all listeners before registering to prevent duplicates on retry
      client.removeAllListeners();

      const usersRef = [];

      client.on('user-published', async (user, mediaType) => {
        await client.subscribe(user, mediaType);
        const idx = usersRef.findIndex(u => u.uid === user.uid);
        if (idx >= 0) {
          usersRef[idx] = { ...usersRef[idx], ...user };
        } else {
          usersRef.push({ uid: user.uid, audioTrack: user.audioTrack, videoTrack: user.videoTrack });
        }
        setRemoteUsers(filterSupervisor([...usersRef]));

        if (mediaType === 'audio' && user.audioTrack) {
          user.audioTrack.play();
        }
      });

      client.on('user-unpublished', (user, mediaType) => {
        const idx = usersRef.findIndex(u => u.uid === user.uid);
        if (idx >= 0) {
          if (mediaType === 'audio') usersRef[idx] = { ...usersRef[idx], audioTrack: null };
          if (mediaType === 'video') usersRef[idx] = { ...usersRef[idx], videoTrack: null };
          setRemoteUsers(filterSupervisor([...usersRef]));
        }
      });

      client.on('user-left', (user) => {
        const idx = usersRef.findIndex(u => u.uid === user.uid);
        if (idx >= 0) usersRef.splice(idx, 1);
        setRemoteUsers(filterSupervisor([...usersRef]));
      });

      // Join channel
      const uid = role === 'supervisor' ? `_sv_${username}` : username;
      await client.join(AGORA_APP_ID, channelName, null, uid);

      // Supervisor doesn't publish tracks
      let audioTrack = null;
      let videoTrack = null;

      if (role !== 'supervisor') {
        try {
          audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        } catch (err) {
          console.warn('Microphone access failed:', err);
        }

        try {
          videoTrack = await AgoraRTC.createCameraVideoTrack();
        } catch (err) {
          console.warn('Camera access failed:', err);
        }

        const tracksToPublish = [audioTrack, videoTrack].filter(Boolean);
        if (tracksToPublish.length > 0) {
          await client.publish(tracksToPublish);
        }

        if (videoTrack && localVideoRef.current) {
          videoTrack.play(localVideoRef.current);
        }
        localVideoTrackRef.current = videoTrack;
      }

      // Batch all setState at the end
      setLocalAudioTrack(audioTrack);
      setIsJoined(true);
      setIsConnecting(false);

    } catch (err) {
      console.error('Agora join failed:', err);
      setIsConnecting(false);
    }
  }, [channelName, username, role, isConnecting, isJoined, filterSupervisor]);

  const leaveChannel = useCallback(async () => {
    try {
      if (localAudioTrack) {
        localAudioTrack.stop();
        localAudioTrack.close();
      }
      if (localVideoTrackRef.current) {
        localVideoTrackRef.current.stop();
        localVideoTrackRef.current.close();
      }
      if (clientRef.current) {
        await clientRef.current.leave();
        clientRef.current.removeAllListeners();
        clientRef.current = null;
      }
    } catch (err) {
      console.warn('Agora leave error:', err);
    }
    setLocalAudioTrack(null);
    localVideoTrackRef.current = null;
    setRemoteUsers([]);
    setIsJoined(false);
    setIsMuted(false);
    setIsCameraOff(false);
  }, [localAudioTrack]);

  const toggleMute = useCallback(async () => {
    if (!localAudioTrack) return;
    await localAudioTrack.setEnabled(isMuted);
    setIsMuted(!isMuted);
  }, [localAudioTrack, isMuted]);

  const toggleCamera = useCallback(async () => {
    if (!localVideoTrackRef.current) return;
    await localVideoTrackRef.current.setEnabled(isCameraOff);
    setIsCameraOff(!isCameraOff);
  }, [isCameraOff]);

  // Auto-join on mount
  useEffect(() => {
    if (channelName && username && !isJoined && !isConnecting) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      joinChannel();
    }
  }, [channelName, username]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        if (localAudioTrack) { localAudioTrack.stop(); localAudioTrack.close(); }
        if (localVideoTrackRef.current) { localVideoTrackRef.current.stop(); localVideoTrackRef.current.close(); }
        clientRef.current.leave().catch(console.warn);
        clientRef.current.removeAllListeners();
        clientRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    localVideoRef,
    remoteUsers,
    localAudioTrack,
    isJoined,
    isConnecting,
    isMuted,
    isCameraOff,
    toggleMute,
    toggleCamera,
    leaveChannel,
    joinChannel
  };
}
