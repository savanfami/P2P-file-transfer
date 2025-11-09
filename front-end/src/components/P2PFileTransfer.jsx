import React, { useState, useEffect, useRef } from "react";
import process from "process";
window.process = process;
import {
  Upload,
  Download,
  Users,
  Wifi,
  WifiOff,
  File,
  Trash2,
  Copy,
  Share2,
  Check,
  Shuffle,
} from "lucide-react";
import { io } from "socket.io-client";
import SimplePeer from "simple-peer";

export const P2PFileSharing = () => {
  const [roomCode, setRoomCode] = useState("");
  const [isInRoom, setIsInRoom] = useState(false);
  const [copied, setCopied] = useState(false);
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [myPeerId, setMyPeerId] = useState("");
  const [peers, setPeers] = useState([]);
  const [availableFiles, setAvailableFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [downloads, setDownloads] = useState({});
  const [isTransferring, setIsTransferring] = useState(false);



  const peersRef = useRef({});
  const fileInputRef = useRef(null);
  const incomingFileRef = useRef(null);
  const receivedChunksRef = useRef([]);
  const receivedSizeRef = useRef(0);
  const selectedFileRef = useRef(null);

  // UI-only states for send flow 
  const [isSending, setIsSending] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [sentFileName, setSentFileName] = useState("");

  const exitRoom = () => {
    if (socket) {
      socket.emit("exit-room", { userId: myPeerId, roomCode });
      socket.disconnect();
    }

    Object.values(peersRef.current).forEach((peer) => peer.destroy());
    peersRef.current = {};

    setPeers([]);
    setAvailableFiles([]);
    setSelectedFile(null);
    localStorage.removeItem("roomCode");

    setIsInRoom(false);
  };

  //---------//
  // room code
  const generateRoomCode = () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomCode(code);
  };

  useEffect(() => {
    if (isInRoom && roomCode) {
      localStorage.setItem("roomCode", roomCode);
    }
  }, [isInRoom, roomCode]);

  // Copy room code 
  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Share room code
  const shareRoomCode = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join my P2P File Sharing Room",
          text: `Join my room with code: ${roomCode}`,
        });
      } catch (err) {
        console.log("Share cancelled");
      }
    } else {
      copyRoomCode();
    }
  };

  // Join room
  const joinRoom = () => {
    if (roomCode.trim()) {
      setIsInRoom(true);
    }
  };

  useEffect(() => {
    const savedRoom = localStorage.getItem("roomCode");
    if (savedRoom) {
      setRoomCode(savedRoom);
      setIsInRoom(true);
    }
  }, []);

  // Initialize Socket.IO
  useEffect(() => {
    if (!isInRoom) return;

    let peerId = localStorage.getItem("peerId");
    if (!peerId) {
      peerId = crypto.randomUUID();
      localStorage.setItem("peerId", peerId);
    }
    const newSocket = io(import.meta.env.VITE_SERVER_URL, {
      query: { userId: peerId, roomCode },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    newSocket.on("connect", () => {
      setIsConnected(true);
      setMyPeerId(peerId);
    });

    newSocket.on("initial-file-offers", (files) => {
      setAvailableFiles(files);
    });

    newSocket.on("disconnect", () => {
      setIsConnected(false);
    });

    newSocket.on("peers-list", (data) => {
      Object.values(peersRef.current).forEach((p) => p.destroy());
      peersRef.current = {};
      setPeers(data.peers || []);
      (data.peers || []).forEach((peerId) => {
        const myPeerId = localStorage.getItem("peerId");
        const shouldInitiate = myPeerId < peerId;
        connectToPeer(peerId, shouldInitiate, newSocket);
      });
    });

    newSocket.on("peer-joined", (data) => {
      setPeers((prev) => [...prev, data.peerId]);
    });

    newSocket.on("peer-left", (data) => {
      setPeers((prev) => prev.filter((id) => id !== data.peerId));
      if (peersRef.current[data.peerId]) {
        peersRef.current[data.peerId].destroy();
        delete peersRef.current[data.peerId];
      }
      setAvailableFiles((prev) => prev.filter((f) => f.peerId !== data.peerId));
    });

    newSocket.on("peer-reconnected", (data) => {
      setPeers((prev) => {
        if (prev.includes(data.peerId)) return prev;
        return [...prev, data.peerId];
      });
      const myPeerId = localStorage.getItem("peerId");
      const shouldInitiate = myPeerId < data.peerId;
      connectToPeer(data.peerId, shouldInitiate, newSocket);
    });

    newSocket.on("signal", (data) => {
      if (!peersRef.current[data.from]) {
        const shouldInitiate = data.signal.type === "answer";
        connectToPeer(data.from, shouldInitiate, newSocket);
      }
      if (peersRef.current[data.from]) {
        try {
          peersRef.current[data.from].signal(data.signal);
        } catch (err) {
          console.error("Error signaling peer:", err);
          if (peersRef.current[data.from]) {
            peersRef.current[data.from].destroy();
            delete peersRef.current[data.from];
          }
        }
      }
    });

    newSocket.on("file-available", (fileData) => {
      setAvailableFiles((prev) => {
        const exists = prev.find((f) => f.fileId === fileData.fileId);
        if (exists) return prev;
        return [...prev, fileData];
      });
    });

    newSocket.on("file-removed", (data) => {
      setAvailableFiles((prev) => prev.filter((f) => f.fileId !== data.fileId));
    });

    setSocket(newSocket);

    return () => {
      Object.values(peersRef.current).forEach((peer) => peer.destroy());
      newSocket.close();
    };
  }, [isInRoom, roomCode]);

  const connectToPeer = (peerId, initiator, socketInstance) => {
    if (peersRef.current[peerId]) return;

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" },
        ],
      },
    });

    peer.on("signal", (signal) => {
      (socketInstance || socket).emit("signal", {
        signal,
        to: peerId,
        type: initiator ? "offer" : "answer",
      });
    });

    peer.on("connect", () => {
      if (selectedFile) {
        peer.send(
          JSON.stringify({
            type: "file-info",
            fileName: selectedFile.name,
            fileSize: selectedFile.size,
            fileType: selectedFile.type,
            fileId: selectedFile.fileId,
          })
        );
      }
    });

    peer.on("data", (data) => {
      handlePeerData(peerId, data);
    });

    peer.on("error", (err) => {
      console.error("Peer error:", err);
    });

    peersRef.current[peerId] = peer;
  };

  const handlePeerData = (peerId, data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "file-request") {
        if (
          selectedFileRef.current &&
          selectedFileRef.current.fileId === message.fileId
        ) {
          sendFile(peerId);
        }
      } else if (message.type === "file-start") {
        incomingFileRef.current = message;
        receivedChunksRef.current = [];
        receivedSizeRef.current = 0;

        setIsTransferring(true);
        setDownloads((prev) => ({
          ...prev,
          [message.fileId]: {
            fileName: message.fileName,
            fileSize: message.fileSize,
            progress: 0,
            status: "downloading",
          },
        }));
      }
    } catch (e) {
      if (incomingFileRef.current) {
        receivedChunksRef.current.push(data);
        receivedSizeRef.current += data.length;

        const progress =
          (receivedSizeRef.current / incomingFileRef.current.fileSize) * 100;

        setDownloads((prev) => ({
          ...prev,
          [incomingFileRef.current.fileId]: {
            ...prev[incomingFileRef.current.fileId],
            progress: Math.round(progress),
          },
        }));

        if (receivedSizeRef.current >= incomingFileRef.current.fileSize) {
          saveReceivedFile();
          setIsTransferring(false);
        }
      }
    }
  };

  const sendFile = async (peerId) => {
    const fileToSend = selectedFileRef.current;
    const peer = peersRef.current[peerId];
    if (!fileToSend || !peer) return;

    peer.send(
      JSON.stringify({
        type: "file-start",
        fileName: fileToSend.name,
        fileSize: fileToSend.size,
        fileType: fileToSend.type,
        fileId: fileToSend.fileId,
      })
    );

    const CHUNK_SIZE = 64 * 1024;
    let offset = 0;
    const totalSize = fileToSend.size;

    while (offset < totalSize) {
      const slice = fileToSend.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();

      while (peer._channel.bufferedAmount > 1 * 1024 * 1024) {
        await new Promise((res) => setTimeout(res, 10));
      }

      try {
        peer.send(buffer);
      } catch (err) {
        console.error("Error sending chunk:", err);
        return;
      }

      offset += buffer.byteLength;
    }
  };

  const saveReceivedFile = () => {
    const blob = new Blob(receivedChunksRef.current, {
      type: incomingFileRef.current.fileType,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = incomingFileRef.current.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setDownloads((prev) => ({
      ...prev,
      [incomingFileRef.current.fileId]: {
        ...prev[incomingFileRef.current.fileId],
        status: "completed",
        progress: 100,
      },
    }));
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileId = `${socket?.id || "local"}-${Date.now()}`;
    const fileWithId = Object.assign(file, { fileId });

    setSelectedFile(fileWithId);
    selectedFileRef.current = fileWithId;

    setIsSending(false);
    setIsSent(false);
    setSentFileName("");
  };

  const handleSendFile = async () => {
    if (!selectedFile || !socket) return;

    setIsTransferring(true);
    setIsSending(true);
    setIsSent(false);
    setSentFileName("");

    try {
      socket.emit("file-offer", {
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        fileType: selectedFile.type,
        fileId: selectedFile.fileId,
      });

      Object.values(peersRef.current).forEach((peer) => {
        if (peer.connected) {
          peer.send(
            JSON.stringify({
              type: "file-info",
              fileName: selectedFile.name,
              fileSize: selectedFile.size,
              fileType: selectedFile.type,
              fileId: selectedFile.fileId,
            })
          );
        }
      });

    

      await new Promise((r) => setTimeout(r, 900));

      setIsSending(false);
      setIsSent(true);
      setIsTransferring(false);
      setTimeout(() => {
        setIsSent(false);
        setSentFileName(selectedFile.name); 
      }, 1400);
    } catch (err) {
      console.error("Error sending file:", err);
      setIsSending(false);
      setIsSent(false);
    }
  };

  const requestFile = (fileData) => {
    const peer = peersRef.current[fileData.peerId];

    if (!peer) {
      alert("Peer connection not found. The sender may have disconnected.");
      return;
    }

    if (peer.connected) {
      peer.send(
        JSON.stringify({
          type: "file-request",
          fileId: fileData.fileId,
        })
      );
    } else {
      alert("Peer is not connected. Please wait for connection to establish.");
    }
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  useEffect(() => {
  const handleBeforeUnload = (e) => {
    if (isTransferring) {
      e.preventDefault();
      e.returnValue =
        "A file transfer is in progress. Are you sure you want to leave this page?";
      return e.returnValue;
    }
  };

  window.addEventListener("beforeunload", handleBeforeUnload);

  return () => {
    window.removeEventListener("beforeunload", handleBeforeUnload);
  };
}, [isTransferring]);


  // Room COde Screen
  if (!isInRoom) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black text-white flex items-center justify-center p-6">
        <div className="max-w-md w-full">
          <div className="bg-white/5 backdrop-blur-lg border border-white/10 rounded-3xl p-8 shadow-2xl">
            <div className="text-center mb-6">
              <h1 className="text-4xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-yellow-300">
                🎬 P2P File Sharing
              </h1>
              <p className="text-gray-400 mt-2">
                Connect directly with peers and transfer files securely.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-gray-300 mb-2">
                  Enter Room Code
                </label>
                <input
                  type="text"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                  placeholder="Enter code or generate one"
                  className="w-full px-4 py-3 border border-white/10 bg-white/5 rounded-xl focus:border-orange-400 focus:outline-none text-lg font-mono text-center uppercase text-white"
                  maxLength={8}
                />
              </div>

              <button
                onClick={generateRoomCode}
                className="w-full px-4 py-3 bg-white/6 hover:bg-white/8 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                <Shuffle size={18} />
                Generate Random Code
              </button>

              {roomCode && (
                <div className="flex gap-2">
                  <button
                    onClick={copyRoomCode}
                    className="flex-1 px-4 py-3 bg-white/6 hover:bg-white/8 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    {copied ? (
                      <>
                        <Check size={18} />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy size={18} />
                        Copy
                      </>
                    )}
                  </button>
                  <button
                    onClick={shareRoomCode}
                    className="flex-1 px-4 py-3 bg-white/6 hover:bg-white/8 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    <Share2 size={18} />
                    Share
                  </button>
                </div>
              )}

              <button
                onClick={joinRoom}
                disabled={!roomCode.trim()}
                className="w-full px-6 py-4 bg-gradient-to-r from-orange-500 to-yellow-400 hover:from-orange-600 hover:to-yellow-500 text-black font-bold rounded-xl transition-all text-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Join Room
              </button>
            </div>

            <div className="mt-6 p-4 bg-white/3 rounded-xl">
              <p className="text-sm text-gray-300 text-center">
                💡 Share the room code with others to start transferring files
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Main App Screen 
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-black text-white p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center">
            <h1 className="text-4xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-yellow-300">
              🎬 P2P File Sharing
            </h1>
            {/* <div className="text-sm text-gray-300 mr-5">Peer-to-peer browser transfers</div> */}
          </div>

          <div className="flex items-center gap-4">
            <div className="bg-white/5 backdrop-blur rounded-xl p-3 border border-white/10 flex items-center gap-3">
              <div className="text-xs text-gray-300">Room</div>
              <div className="font-mono font-bold text-lg">{roomCode}</div>
              <button
                onClick={copyRoomCode}
                className="p-2 rounded-md hover:bg-white/6 transition-colors"
              >
                {copied ? <Check className="text-green-400" size={16} /> : <Copy size={16} />}
              </button>
            </div>

            <button
              onClick={exitRoom}
              className="px-3 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white font-semibold transition"
            >
              Exit Room
            </button>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-8">
          <div className="space-y-6">
            {/* Status Card */}
            <div className="bg-white/5 backdrop-blur border border-white/8 rounded-2xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isConnected ? "bg-green-500/10 border border-green-400/30" : "bg-red-500/10 border border-red-400/30"}`}>
                  {isConnected ? <Wifi className="text-green-300" /> : <WifiOff className="text-red-300" />}
                </div>
                <div>
                  <div className="font-semibold text-white">
                    {isConnected ? "Connected" : "Disconnected"}
                  </div>
                  {isConnected && <div className="text-xs text-gray-400 font-mono">Your ID: {myPeerId}</div>}
                </div>
              </div>
              <div className="bg-white/6 px-3 py-2 rounded-full flex items-center gap-2 border border-white/8">
                <Users size={18} className="text-orange-300" />
                <div className="font-semibold">{peers.length}</div>
              </div>
            </div>

            {/* Upload Card */}
            <div className="bg-white/5 backdrop-blur border border-white/8 rounded-2xl p-6">
              <h3 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Upload size={18} className="text-orange-300" />
                Share a file
              </h3>

              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-white/8 rounded-xl p-8 text-center cursor-pointer hover:border-orange-400 transition"
              >
                <File size={48} className="mx-auto text-gray-300 mb-3" />
                <div className="text-lg font-semibold">Click to select a file</div>
                <div className="text-sm text-gray-400">Movies, videos, or any file</div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileSelect}
                className="hidden"
              />

              {/* Selected file card */}
              {selectedFile && (
                <div className="mt-4 p-4 bg-white/6 border border-white/8 rounded-xl">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className={`font-semibold text-lg text-left ${sentFileName ? "text-green-300" : "text-white"}`}>
                        {sentFileName ? `${sentFileName} sent successfully` : selectedFile.name}
                      </div>
                      <div className="text-sm text-gray-400 text-left">{formatBytes(selectedFile.size)}</div>
                    </div>

                    <button
                      onClick={() => {
                        if (!sentFileName) {
                          if (selectedFile && socket) {
                            socket.emit("remove-file-offer", {
                              fileId: selectedFile.fileId,
                            });
                          }
                          setSelectedFile(null);
                          setIsSending(false);
                          setIsSent(false);
                        } else {
                          setSentFileName("");
                          setSelectedFile(null);
                        }
                      }}
                      className={`p-2 rounded-lg ${sentFileName ? "bg-green-500/10 hover:bg-green-500/20" : "bg-red-500/10 hover:bg-red-500/20"}`}
                    >
                      <Trash2 className={sentFileName ? "text-green-300" : "text-red-300"} size={18} />
                    </button>
                  </div>

                  {!sentFileName && (
                    <button
                      onClick={handleSendFile}
                      disabled={isSending || isSent}
                      className={`w-full px-5 py-3 rounded-lg text-black font-semibold transition flex items-center justify-center gap-3 ${
                        isSent
                          ? "bg-green-400/20 border border-green-500 text-green-300"
                          : "bg-gradient-to-r from-orange-500 to-yellow-400 hover:from-yellow-500 hover:to-orange-400 cursor-pointer"
                      }`}
                    >
                      {isSending ? (
                        <>
                          <div className="w-5 h-5 border-3 border-t-transparent border-yellow-300 rounded-full animate-spin" />
                          <span className="text-sm font-medium truncate">{selectedFile.name}</span>
                        </>
                      ) : isSent ? (
                        <>
                          <div className="w-7 h-7 rounded-full border-2 border-green-400 flex items-center justify-center bg-green-400/8">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          </div>
                          <span className="text-green-300 font-semibold">Sent</span>
                        </>
                      ) : (
                        <>
                          <Upload size={16} />
                          <span className="cursor-pointer">Send File</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Available Files */}
            <div className="bg-white/5 backdrop-blur border border-white/8 rounded-2xl p-6">
              <h3 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Download size={18} className="text-blue-300" />
                Available Files
              </h3>

              {availableFiles.length === 0 ? (
                <div className="text-center text-gray-400 py-8">No files available yet...</div>
              ) : (
                <div className="space-y-3 max-h-56 overflow-y-auto">
                  {availableFiles.map((file) => (
                    <div key={file.fileId} className="flex items-center justify-between p-3 bg-white/3 rounded-xl border border-white/6">
                      <div>
                        <div className="font-semibold text-left mr-3">{file.fileName}</div>
                        <div className="text-xs text-gray-400 text-left">{formatBytes(file.fileSize)} • From {file.peerId.substring(0,8)}...</div>
                      </div>
                      <button
                        onClick={() => requestFile(file)}
                        className="px-3 py-2 bg-orange-500 rounded-md text-white font-semibold"
                      >
                        Download
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Downloads */}
            {Object.keys(downloads).length > 0 && (
              <div className="bg-white/5 backdrop-blur border border-white/8 rounded-2xl p-6">
                <h3 className="text-xl font-semibold mb-4 text-left flex align-items gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 48 48"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M40.518 34.316A9.21 9.21 0 0 0 44 24c-1.213-3.83-4.93-5.929-8.947-5.925h-2.321a14.737 14.737 0 1 0-25.31 13.429M24.008 41L24 23m6.364 11.636L24 41l-6.364-6.364"/></svg>
                  Downloads</h3>
                <div className="space-y-3">
                  {Object.entries(downloads).map(([fileId, download]) => (
                    <div key={fileId} className="p-3 bg-white/3 rounded-xl">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-semibold text-left">{download.fileName}</div>
                        <div className="text-sm text-gray-300">
                          {download.status === "completed" ? "✅ Complete" : `${download.progress}%`}
                        </div>
                      </div>
                      <div className="w-full h-2 bg-white/6 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-orange-400 to-yellow-300 transition-all"
                          style={{ width: `${download.progress}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT: Info Section */}
          <div className="space-y-6">
            <div className="bg-white/5 backdrop-blur border border-white/8 rounded-2xl p-6">
              <h3 className="text-2xl font-semibold text-orange-300 mb-2">How P2P Sharing Works</h3>
              <p className="text-gray-300">
                Peer-to-peer (P2P) file sharing connects devices directly without a central server.
                Files are transferred using secure WebRTC data channels for low-latency, encrypted transfer.
              </p>
              <ul className="mt-4 space-y-2 text-gray-300">
                <li className="flex items-start gap-3">
                  <span className="text-green-400"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M20.8 6.2a.75.75 0 0 1 .04 1.06l-9.75 10.5a.75.75 0 0 1-1.117-.02l-4.75-5.5a.753.753 0 0 1 1.137-.983l4.2 4.87l9.18-9.89a.75.75 0 0 1 1.06-.039z" clip-rule="evenodd"/></svg></span>
                  Direct device-to-device transfer — no third party.
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-green-400"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M20.8 6.2a.75.75 0 0 1 .04 1.06l-9.75 10.5a.75.75 0 0 1-1.117-.02l-4.75-5.5a.753.753 0 0 1 1.137-.983l4.2 4.87l9.18-9.89a.75.75 0 0 1 1.06-.039z" clip-rule="evenodd"/></svg></span>
                  Fast and encrypted — powered by WebRTC data channels.
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-green-400"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M20.8 6.2a.75.75 0 0 1 .04 1.06l-9.75 10.5a.75.75 0 0 1-1.117-.02l-4.75-5.5a.753.753 0 0 1 1.137-.983l4.2 4.87l9.18-9.89a.75.75 0 0 1 1.06-.039z" clip-rule="evenodd"/></svg></span>
                  Works in browsers without extra setup.
                </li>
              </ul>
            </div>

            <div className="bg-white/5 backdrop-blur border border-white/8 rounded-2xl p-6">
              <h3 className="text-2xl font-semibold text-yellow-300 mb-2">Why Use P2P File Sharing?</h3>
              <p className="text-gray-300">
                With P2P, your data moves directly between devices — improving speed, privacy, and scalability.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="p-3 bg-white/3 rounded-xl text-center">
                  <div className="text-2xl font-bold text-orange-300">0%</div>
                  <div className="text-xs text-gray-300">Server Dependency</div>
                </div>
                <div className="p-3 bg-white/3 rounded-xl text-center">
                  <div className="text-2xl font-bold text-green-300">100%</div>
                  <div className="text-xs text-gray-300">Peer Privacy</div>
                </div>
              </div>
            </div>

            <div className="bg-white/5 backdrop-blur border border-white/8 rounded-2xl p-6">
              <h3 className="text-2xl font-semibold text-blue-300 mb-2">Room & Connection</h3>
              <div className="text-gray-300 text-sm">
                Share your room code to invite peers. Connections are established via WebRTC — peers will appear on the left panel.
              </div>
              <div className="mt-4 flex items-center gap-3">
                <div className="bg-white/6 px-3 py-2 rounded-full text-sm font-mono">{roomCode}</div>
                <div className="text-sm text-gray-300">Peers: <span className="font-semibold">{peers.length}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
