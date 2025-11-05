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

  const peersRef = useRef({});
  const fileInputRef = useRef(null);
  const incomingFileRef = useRef(null);
  const receivedChunksRef = useRef([]);
  const receivedSizeRef = useRef(0);
  const selectedFileRef = useRef(null);

  // Generate random room code
  const generateRoomCode = () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomCode(code);
  };

  // Copy room code to clipboard
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

    const fileId = `${socket.id}-${Date.now()}`;
    const fileWithId = Object.assign(file, { fileId });

    setSelectedFile(fileWithId);
    selectedFileRef.current = fileWithId;
  };

  const handleSendFile = () => {
    if (!selectedFile || !socket) return;

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

  // Room Entry Screen
  if (!isInRoom) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-500 via-amber-500 to-yellow-500 flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-md w-full">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-800 mb-2">
              🎬 P2P File Sharing
            </h1>
            <p className="text-gray-600">Share files directly with peers</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Enter Room Code
              </label>
              <input
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="Enter code or generate one"
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-xl focus:border-orange-500 focus:outline-none text-lg font-mono text-center uppercase"
                maxLength={8}
              />
            </div>

            <button
              onClick={generateRoomCode}
              className="w-full px-4 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              <Shuffle size={20} />
              Generate Random Code
            </button>

            {roomCode && (
              <div className="flex gap-2">
                <button
                  onClick={copyRoomCode}
                  className="flex-1 px-4 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  {copied ? (
                    <>
                      <Check size={20} />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy size={20} />
                      Copy
                    </>
                  )}
                </button>
                <button
                  onClick={shareRoomCode}
                  className="flex-1 px-4 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <Share2 size={20} />
                  Share
                </button>
              </div>
            )}

            <button
              onClick={joinRoom}
              disabled={!roomCode.trim()}
              className="w-full px-6 py-4 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 disabled:from-gray-300 disabled:to-gray-300 text-white font-bold rounded-xl transition-all text-lg disabled:cursor-not-allowed"
            >
              Join Room
            </button>
          </div>

          <div className="mt-6 p-4 bg-orange-50 rounded-xl">
            <p className="text-sm text-gray-600 text-center">
              💡 Share the room code with others to start transferring files
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Main App Screen
  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-500 via-amber-500 to-yellow-500 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-5xl font-bold text-white drop-shadow-lg">
            🎬 P2P File Sharing
          </h1>
          <div className="bg-white rounded-xl px-6 py-3 shadow-lg">
            <div className="text-sm text-gray-600 font-semibold">Room Code</div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold font-mono">{roomCode}</span>
              <button
                onClick={copyRoomCode}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                {copied ? (
                  <Check size={20} className="text-green-600" />
                ) : (
                  <Copy size={20} className="text-gray-600" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Status Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-6 mb-6">
          <div
            className={`flex items-center gap-3 p-4 rounded-xl ${
              isConnected
                ? "bg-green-100 border-2 border-green-400"
                : "bg-red-100 border-2 border-red-400"
            }`}
          >
            {isConnected ? (
              <Wifi className="text-green-600" />
            ) : (
              <WifiOff className="text-red-600" />
            )}
            <div className="flex-1">
              <div className="font-bold text-lg text-black font-serif">
                {isConnected ? "✅ Connected to Network" : "⚠️ Disconnected"}
              </div>
              {isConnected && (
                <div className="text-sm text-gray-600 font-mono">
                  Your ID: {myPeerId}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg">
              <Users className="text-black" size={20} />
              <span className="font-bold text-xl">{peers.length}</span>
            </div>
          </div>
        </div>

        {/* Upload Section */}
        <div className="bg-white rounded-2xl shadow-2xl p-6 mb-6">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
            <Upload className="text-gray-600" />
            Share a File
          </h2>

          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-4 border-dashed border-gray-300 rounded-xl p-12 text-center cursor-pointer hover:border-orange-200 transition-all"
          >
            <File className="mx-auto text-gray-700 mb-4" size={64} />
            <p className="text-xl font-semibold text-black mb-2">
              Click to select a file
            </p>
            <p className="text-gray-700">Movies, videos or any large files</p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
          />

          {selectedFile && (
            <div className="mt-4 p-4 bg-green-50 border-2 border-green-200 rounded-xl">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="font-bold text-lg">{selectedFile.name}</div>
                  <div className="text-gray-600">
                    {formatBytes(selectedFile.size)}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (selectedFile && socket) {
                      socket.emit("remove-file-offer", {
                        fileId: selectedFile.fileId,
                      });
                    }
                    setSelectedFile(null);
                  }}
                  className="p-2 hover:bg-red-100 rounded-lg transition-colors"
                >
                  <Trash2 className="text-red-500 cursor-pointer" size={20} />
                </button>
              </div>
              <button
                onClick={handleSendFile}
                className="w-full px-6 py-3 bg-gray-600 cursor-pointer text-white rounded-lg font-semibold hover:bg-gray-800 transition-colors flex items-center justify-center gap-2"
              >
                <Upload size={20} />
                Send File
              </button>
            </div>
          )}
        </div>

        {/* Available Files */}
        <div className="bg-white rounded-2xl shadow-2xl p-6 mb-6">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
            <Download className="text-black" />
            Available Files
          </h2>

          {availableFiles.length === 0 ? (
            <p className="text-center text-gray-500 py-8">
              No files available yet...
            </p>
          ) : (
            <div className="space-y-3">
              {availableFiles.map((file) => (
                <div
                  key={file.fileId}
                  className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border-2 border-gray-200 hover:border-orange-200 transition-all"
                >
                  <div className="flex-1">
                    <div className="font-bold text-lg">🎬 {file.fileName}</div>
                    <div className="text-sm text-gray-600">
                      {formatBytes(file.fileSize)} • From:{" "}
                      {file.peerId.substring(0, 8)}...
                    </div>
                  </div>
                  <button
                    onClick={() => requestFile(file)}
                    className="px-6 py-3 bg-orange-500 text-white font-semibold rounded-lg cursor-pointer transition-colors"
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Download Progress */}
        {Object.keys(downloads).length > 0 && (
          <div className="bg-white rounded-2xl shadow-2xl p-6">
            <h2 className="text-2xl font-bold mb-4">⬇️ Downloads</h2>
            <div className="space-y-3">
              {Object.entries(downloads).map(([fileId, download]) => (
                <div key={fileId} className="p-4 bg-gray-50 rounded-xl">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-bold">{download.fileName}</div>
                    <div className="text-sm font-semibold">
                      {download.status === "completed"
                        ? "✅ Complete"
                        : `${download.progress}%`}
                    </div>
                  </div>
                  <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-gray-100 to-orange-500 transition-all duration-300"
                      style={{ width: `${download.progress}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};