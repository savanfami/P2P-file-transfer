import { Server } from "socket.io";

const peers = new Map();
const fileOffers = new Map();

export const initializeSocket = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin:"http://localhost:5173",
      methods: ["GET", "POST"],
      credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  io.on("connection", (socket) => {
    console.log(`🟢 Peer connected: ${socket.id}`);
    
    // Store peer info
    peers.set(socket.id, {
      id: socket.id,
      connectedAt: Date.now(),
      files: []
    });

    // Send current peer count and list
    socket.emit("peers-list", {
      peers: Array.from(peers.keys()).filter(id => id !== socket.id),
      totalPeers: peers.size
    });

    // Notify others about new peer
    socket.broadcast.emit("peer-joined", {
      peerId: socket.id,
      totalPeers: peers.size
    });

    // Handle WebRTC signaling (offer/answer/ice candidates)
    socket.on("signal", (data) => {
      const { to, signal, type } = data;
      console.log(signal,'signal');
      
      if (!to) {
        console.log(" Signal missing 'to' field");
        return;
      }

      console.log(`📡 Signal [${type || 'unknown'}] from ${socket.id} to ${to}`);
      
      io.to(to).emit("signal", {
        signal,
        from: socket.id,
        type
      });
    });

    // Handle file offer announcement
    socket.on("file-offer", (data) => {
      const { fileName, fileSize, fileType, fileId } = data;
      
      if (!fileName || !fileSize) {
        console.error("❌ Invalid file offer");
        return;
      }

      const offer = {
        fileId: fileId || `${socket.id}-${Date.now()}`,
        fileName,
        fileSize,
        fileType,
        peerId: socket.id,
        offeredAt: Date.now()
      };

      // Store file offer
      fileOffers.set(offer.fileId, offer);
      
      // Update peer's file list
      const peer = peers.get(socket.id);
      if (peer) {
        peer.files.push(offer);
      }

      console.log(`📁 File offered: ${fileName} (${formatBytes(fileSize)}) by ${socket.id}`);

      // Broadcast to all other peers
      socket.broadcast.emit("file-available", offer);
      
      // Send confirmation back to sender
      socket.emit("file-offer-success", { fileId: offer.fileId });
    });

    // Handle file request
    socket.on("file-request", (data) => {
      const { fileId, targetPeerId } = data;
      
      if (!fileId || !targetPeerId) {
        console.error("❌ Invalid file request");
        return;
      }

      console.log(`📥 File request: ${fileId} from ${socket.id} to ${targetPeerId}`);
      
      // Forward request to file owner
      io.to(targetPeerId).emit("file-request-received", {
        fileId,
        requesterId: socket.id
      });
    });

    // Handle file transfer initiation
    socket.on("file-transfer-start", (data) => {
      const { fileId, targetPeerId } = data;
      
      console.log(`🚀 File transfer starting: ${fileId}`);
      
      io.to(targetPeerId).emit("file-transfer-initiated", {
        fileId,
        senderId: socket.id
      });
    });

    // Handle file transfer completion
    socket.on("file-transfer-complete", (data) => {
      const { fileId, success } = data;
      
      console.log(`${success ? '✅' : '❌'} File transfer ${success ? 'completed' : 'failed'}: ${fileId}`);
      
      socket.emit("transfer-status", {
        fileId,
        status: success ? "completed" : "failed"
      });
    });

    // Handle peer status updates
    socket.on("peer-status", (data) => {
      const peer = peers.get(socket.id);
      if (peer) {
        peer.status = data.status;
        peer.lastUpdate = Date.now();
      }
    });

    // Get all available files
    socket.on("get-available-files", () => {
      const allFiles = Array.from(fileOffers.values())
        .filter(offer => offer.peerId !== socket.id);
      
      socket.emit("available-files-list", allFiles);
    });

    // Remove file offer
    socket.on("remove-file-offer", (data) => {
      const { fileId } = data;
      
      if (fileOffers.has(fileId)) {
        const offer = fileOffers.get(fileId);
        if (offer.peerId === socket.id) {
          fileOffers.delete(fileId);
          socket.broadcast.emit("file-removed", { fileId });
          console.log(`🗑️ File offer removed: ${fileId}`);
        }
      }
    });

    // Handle peer ready state
    socket.on("peer-ready", () => {
      const peer = peers.get(socket.id);
      if (peer) {
        peer.ready = true;
        console.log(`✅ Peer ready: ${socket.id}`);
      }
    });

    // Handle errors
    socket.on("error", (error) => {
      console.error(`❌ Socket error for ${socket.id}:`, error);
    });

    // Handle disconnection
    socket.on("disconnect", (reason) => {
      console.log(`🔴 Peer disconnected: ${socket.id} (${reason})`);
      
      // Remove peer's file offers
      const peer = peers.get(socket.id);
      if (peer && peer.files) {
        peer.files.forEach(file => {
          fileOffers.delete(file.fileId);
          socket.broadcast.emit("file-removed", { fileId: file.fileId });
        });
      }

      // Remove peer
      peers.delete(socket.id);
      
      // Notify others
      socket.broadcast.emit("peer-left", {
        peerId: socket.id,
        totalPeers: peers.size
      });
    });
  });

  // Cleanup old file offers periodically (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    for (const [fileId, offer] of fileOffers.entries()) {
      if (now - offer.offeredAt > maxAge) {
        fileOffers.delete(fileId);
        io.emit("file-removed", { fileId });
        console.log(`🗑️ Cleaned up old file offer: ${fileId}`);
      }
    }
  }, 5 * 60 * 1000);

  console.log("✅ Socket.IO initialized");
  return io;
};

// Helper function
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Export stats function for monitoring
export const getSocketStats = () => {
  return {
    totalPeers: peers.size,
    totalFileOffers: fileOffers.size,
    peers: Array.from(peers.values()).map(p => ({
      id: p.id,
      filesShared: p.files?.length || 0,
      connectedAt: p.connectedAt
    }))
  };
};