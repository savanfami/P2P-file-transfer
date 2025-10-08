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
} from "lucide-react";
import { io } from "socket.io-client";
import SimplePeer from "simple-peer";

export const P2PFileSharing = () => {
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
  const CHUNK_SIZE = 16384; // 16KB

  // Initialize Socket.IO
  useEffect(() => {
    const newSocket = io("http://localhost:3000", {
      transports: ["websocket"],
      reconnection: true,
    });

    newSocket.on("connect", () => {
      setIsConnected(true);
      setMyPeerId(newSocket.id);
      console.log("✅ Connected to server:", newSocket.id);
    });

    newSocket.on("disconnect", () => {
      setIsConnected(false);
      console.log("❌ Disconnected");
    });

    newSocket.on("peers-list", (data) => {
      console.log("👥 Peers list:", data);
      setPeers(data.peers || []);
      // Connect to existing peers - use ID comparison to determine initiator
      (data.peers || []).forEach((peerId) => {
        const shouldInitiate = newSocket.id < peerId; // Consistent initiator selection
        console.log(
          `Connecting to ${peerId}, I am initiator: ${shouldInitiate}`
        );
        connectToPeer(peerId, shouldInitiate, newSocket);
      });
    });

    newSocket.on("peer-joined", (data) => {
      console.log("🟢 Peer joined:", data.peerId);
      setPeers((prev) => [...prev, data.peerId]);
      // Don't initiate connection here - let the signal handler do it
      // This prevents both peers from trying to be initiator
    });

    newSocket.on("peer-left", (data) => {
      console.log("🔴 Peer left:", data.peerId);
      setPeers((prev) => prev.filter((id) => id !== data.peerId));
      if (peersRef.current[data.peerId]) {
        peersRef.current[data.peerId].destroy();
        delete peersRef.current[data.peerId];
      }
      setAvailableFiles((prev) => prev.filter((f) => f.peerId !== data.peerId));
    });

    newSocket.on("signal", (data) => {
      console.log(
        "📡 Signal received from:",
        data.from,
        "Type:",
        data.signal.type
      );

      // If we receive an offer and don't have a peer connection, create one as non-initiator
      if (!peersRef.current[data.from]) {
        const shouldInitiate = data.signal.type === "answer";
        console.log(`Creating peer connection (initiator: ${shouldInitiate})`);
        connectToPeer(data.from, shouldInitiate, newSocket);
      }

      // Signal the peer connection
      if (peersRef.current[data.from]) {
        try {
          peersRef.current[data.from].signal(data.signal);
        } catch (err) {
          console.error("Error signaling peer:", err);
          // If there's an error, destroy and recreate the connection
          if (peersRef.current[data.from]) {
            peersRef.current[data.from].destroy();
            delete peersRef.current[data.from];
          }
        }
      }
    });

    newSocket.on("file-available", (fileData) => {
      console.log("📁 File available:", fileData);
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
  }, []);

  const connectToPeer = (peerId, initiator, socketInstance) => {
    // Prevent duplicate connections
    if (peersRef.current[peerId]) {
      console.log("⚠️ Peer connection already exists:", peerId);
      return;
    }

    console.log(`🔗 Connecting to peer: ${peerId} (initiator: ${initiator})`);

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      // config: {
      //   iceServers: [
      //     { urls: "stun:stun.l.google.com:19302" },
      //     { urls: "stun:global.stun.twilio.com:3478" },
      //   ],
      // },
    });

    //fires offer to the backend with candidate
    peer.on("signal", (signal) => {
      console.log("📤 Sending signal to:", peerId);
      (socketInstance || socket).emit("signal", {
        signal,
        to: peerId,
        type: initiator ? "offer" : "answer",
      });
    });

    //after both parties handshake is completed
    peer.on("connect", () => {
      console.log("🤝 Peer connection successful:", peerId);
      // Send file info if we have one
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
      console.log("📦 Data received from peer:", peerId, "Size:", data.length);
      handlePeerData(peerId, data);
    });

    peer.on("error", (err) => {
      console.error("❌ Peer error:", err);
    });

    peersRef.current[peerId] = peer;
  };

  const handlePeerData = (peerId, data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log("📨 Message received:", message.type, "from peer:", peerId);

      if (message.type === "file-info") {
        console.log("📄 File info received:", message);
      } else if (message.type === "file-request") {
        console.log("📥 File request received from:", peerId);
        console.log("   Requested fileId:", message.fileId);
        console.log(
          "   My selected file:",
          selectedFileRef.current
            ? selectedFileRef.current.fileId
            : "No file selected"
        );
        console.log("   Peer connected:", peersRef.current[peerId]?.connected);

        // Check if this is the file they're requesting
        if (
          selectedFileRef.current &&
          selectedFileRef.current.fileId === message.fileId
        ) {
          console.log("✅ File match! Starting transfer...");
          sendFile(peerId);
        } else {
          console.error("❌ File mismatch or no file selected");
        }
      } else if (message.type === "file-start") {
        console.log("🚀 File transfer starting:", message.fileName);
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
      // Binary data (file chunk)
      if (incomingFileRef.current) {
        receivedChunksRef.current.push(data);
        receivedSizeRef.current += data.length;

        const progress =
          (receivedSizeRef.current / incomingFileRef.current.fileSize) * 100;

        console.log(`⬇️ Progress: ${Math.round(progress)}%`);

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

  const sendFile = (peerId) => {
    const fileToSend = selectedFileRef.current; // Use ref instead of state

    if (!fileToSend || !peersRef.current[peerId]) {
      console.error("❌ Cannot send file - missing file or peer connection");
      console.error("   File:", fileToSend ? fileToSend.name : "none");
      console.error("   Peer exists:", !!peersRef.current[peerId]);
      return;
    }

    const peer = peersRef.current[peerId];

    console.log("📤 Sending file:", fileToSend.name, "to peer:", peerId);

    peer.send(
      JSON.stringify({
        type: "file-start",
        fileName: fileToSend.name,
        fileSize: fileToSend.size,
        fileType: fileToSend.type,
        fileId: fileToSend.fileId,
      })
    );

    const reader = new FileReader();
    let offset = 0;

    reader.onload = (e) => {
      if (peer.connected) {
        peer.send(e.target.result);
        offset += e.target.result.byteLength;

        const progress = (offset / fileToSend.size) * 100;
        console.log(`⬆️ Upload progress: ${Math.round(progress)}%`);

        if (offset < fileToSend.size) {
          readSlice(offset);
        } else {
          console.log("✅ File sent successfully to peer:", peerId);
        }
      }
    };

    const readSlice = (o) => {
      const slice = fileToSend.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
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

    console.log("✅ File saved:", incomingFileRef.current.fileName);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileId = `${socket.id}-${Date.now()}`;
    const fileWithId = Object.assign(file, { fileId });

    setSelectedFile(fileWithId);
    selectedFileRef.current = fileWithId; // Update ref
    console.log("📎 File selected:", file.name, formatBytes(file.size));
  };

  const handleSendFile = () => {
    if (!selectedFile || !socket) return;

    console.log("📢 Broadcasting file to network:", selectedFile.name);

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
    console.log("🔽 Attempting to request file:", fileData.fileName);
    console.log("Available peers:", Object.keys(peersRef.current));
    console.log("Looking for peer:", fileData.peerId);

    const peer = peersRef.current[fileData.peerId];

    if (!peer) {
      console.error("❌ Peer not found in peersRef:", fileData.peerId);
      alert("Peer connection not found. The sender may have disconnected.");
      return;
    }

    console.log("Peer found. Connected:", peer.connected);
    console.log("Peer destroyed:", peer.destroyed);

    if (peer.connected) {
      console.log("✅ Sending file request to peer");
      peer.send(
        JSON.stringify({
          type: "file-request",
          fileId: fileData.fileId,
        })
      );
    } else {
      console.error("❌ Peer exists but not connected");
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 via-blue-600 to-indigo-700 p-6">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-5xl font-bold text-white text-center mb-8 drop-shadow-lg">
          🎬 P2P File Sharing
        </h1>

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
              <div className="font-bold text-lg">
                {isConnected ? "✅ Connected to Network" : "⚠️ Disconnected"}
              </div>
              {isConnected && (
                <div className="text-sm text-gray-600 font-mono">
                  Your ID: {myPeerId}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg">
              <Users className="text-purple-600" size={20} />
              <span className="font-bold text-xl">{peers.length}</span>
            </div>
          </div>
        </div>

        {/* Upload Section */}
        <div className="bg-white rounded-2xl shadow-2xl p-6 mb-6">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
            <Upload className="text-purple-600" />
            Share a File
          </h2>

          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-4 border-dashed border-purple-300 rounded-xl p-12 text-center cursor-pointer hover:border-purple-500 hover:bg-purple-50 transition-all"
          >
            <File className="mx-auto text-purple-400 mb-4" size={64} />
            <p className="text-xl font-semibold text-purple-600 mb-2">
              Click to select a file
            </p>
            <p className="text-gray-500">Movies, videos, or any large files</p>
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
                  <div className="font-bold text-lg">
                    ✅ {selectedFile.name}
                  </div>
                  <div className="text-gray-600">
                    {formatBytes(selectedFile.size)}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedFile(null)}
                  className="p-2 hover:bg-red-100 rounded-lg transition-colors"
                >
                  <Trash2 className="text-red-500" size={20} />
                </button>
              </div>
              <button
                onClick={handleSendFile}
                className="w-full px-6 py-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 transition-colors flex items-center justify-center gap-2"
              >
                <Upload size={20} />
                Send File to Network
              </button>
            </div>
          )}
        </div>

        {/* Available Files */}
        <div className="bg-white rounded-2xl shadow-2xl p-6 mb-6">
          <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
            <Download className="text-blue-600" />
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
                  className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border-2 border-gray-200 hover:border-blue-300 transition-all"
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
                    className="px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
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
                      className="h-full bg-gradient-to-r from-blue-500 to-purple-600 transition-all duration-300"
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
