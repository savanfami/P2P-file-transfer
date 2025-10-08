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
    });

    newSocket.on("disconnect", () => {
      setIsConnected(false);
      console.log("❌ Disconnected");
    });

    newSocket.on("peers-list", (data) => {
      console.log("👥 Peers list:", data);
      setPeers(data.peers || []);
      // Connect to existing peers
      (data.peers || []).forEach((peerId) => {
        connectToPeer(peerId, true, newSocket);
      });
    });

    newSocket.on("peer-joined", (data) => {
      console.log("🟢 Peer joined:", data.peerId);
      setPeers((prev) => [...prev, data.peerId]);
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
      //recieving socket signal and candidate from backend
      if (!peersRef.current[data.from]) {
        connectToPeer(data.from, false, newSocket);
      }
      peersRef.current[data.from].signal(data.signal);
      //peer.signal(data.signal) is a SimplePeer API method.
      // It feeds the WebRTC signaling data (offer/answer/ICE candidates) from the other peer into the current peer.
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
      (socketInstance || socket).emit("signal", {
        signal,
        to: peerId,
        type: initiator ? "offer" : "answer",
      });
    });

    //after both parties handshake is completed
    peer.on("connect", () => {
      console.log("peer connection successfull", peerId);
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

      if (message.type === "file-info") {
        console.log("📄 File info received:", message);
      } else if (message.type === "file-request") {
        console.log("📥 File requested by:", peerId);
        sendFile(peerId);
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
      // Binary data (file chunk)
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

  const sendFile = (peerId) => {
    if (!selectedFile || !peersRef.current[peerId]) return;

    const peer = peersRef.current[peerId];

    peer.send(
      JSON.stringify({
        type: "file-start",
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        fileType: selectedFile.type,
        fileId: selectedFile.fileId,
      })
    );

    const reader = new FileReader();
    let offset = 0;

    reader.onload = (e) => {
      if (peer.connected) {
        peer.send(e.target.result);
        offset += e.target.result.byteLength;

        if (offset < selectedFile.size) {
          readSlice(offset);
        } else {
          console.log("✅ File sent successfully");
        }
      }
    };

    const readSlice = (o) => {
      const slice = selectedFile.slice(o, o + CHUNK_SIZE);
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
    const fileWithId = {
      ...file,
      fileId,
    };

    setSelectedFile(fileWithId);

    socket.emit("file-offer", {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      fileId,
    });

    Object.values(peersRef.current).forEach((peer) => {
      if (peer.connected) {
        peer.send(
          JSON.stringify({
            type: "file-info",
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            fileId,
          })
        );
      }
    });
  };

  const requestFile = (fileData) => {
    const peer = peersRef.current[fileData.peerId];
    if (peer && peer.connected) {
      peer.send(
        JSON.stringify({
          type: "file-request",
          fileId: fileData.fileId,
        })
      );
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
          {/* 🎬 P2P  */}
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
              <div className="flex items-center justify-between">
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
