import { Server } from "socket.io";

const peers = new Map();
const fileOffers = new Map();

export const initializeSocket = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on("connection", (socket) => {
    const { userId } = socket.handshake.query;
    if (!userId) {
      socket.disconnect(true);
      return;
    }
    const existingPeer = peers.get(userId);
    if (existingPeer) {
      existingPeer.socketId = socket.id;
      existingPeer.reconnectedAt = Date.now();
      existingPeer.online = true;
      peers.set(userId, existingPeer);
      socket.emit("peers-list", {
        peers: Array.from(peers.keys()).filter((id) => id !== userId),
      });
      socket.broadcast.emit("peer-reconnected", { peerId: userId });

      console.log(` Peer reconnected: ${userId}`);
    } else {
      peers.set(userId, {
        socketId: socket.id,
        connectedAt: Date.now(),
        files: [],
      });
      console.log(` New peer connected: ${userId}`);
    }

    // Send current peer count and list
    socket.emit("peers-list", {
      peers: Array.from(peers.keys()).filter((id) => id !== userId),
      totalPeers: peers.size,
    });

    // Notify others about new peer
    socket.broadcast.emit("peer-joined", {
      peerId: userId,
      totalPeers: peers.size,
    });

    // Handle WebRTC signaling (offer/answer/ice candidates)
    socket.on("signal", (data) => {
      const { to, signal, type } = data;
      // console.log(signal,'signal');

      if (!to) return;

      console.log(`📡 Signal [${type || "unknown"}] from ${userId} to ${to}`);
      const target = peers.get(to);
      io.to(target.socketId).emit("signal", {
        signal,
        from: userId,
        type,
      });
    });

    // Handle file offer announcement
    socket.on("file-offer", (data) => {
      const { fileName, fileSize, fileType, fileId } = data;

      if (!fileName || !fileSize) return;

      const offer = {
        fileId: fileId || `${userId}-${Date.now()}`,
        fileName,
        fileSize,
        fileType,
        peerId: userId,
        offeredAt: Date.now(),
      };

      //storing file offer
      fileOffers.set(offer.fileId, offer);

      // Update peer's file list
      const peer = peers.get(userId);
      if (peer) peer.files.push(offer);

      // Broadcast to all other peers
      socket.broadcast.emit("file-available", offer);
    });

    // Handle file request
    socket.on("file-request", (data) => {
      const { fileId, targetPeerId } = data;

      if (!fileId || !targetPeerId) return;

      // Forward request to file owner
      const target = peers.get(targetPeerId);
      if (target) {
        io.to(target.socketId).emit("file-request-received", {
          fileId,
          requesterId: userId,
        });
      }
    });

    // Remove file offer
    socket.on("remove-file-offer", (data) => {
      const { fileId } = data;
      const offer = fileOffers.get(fileId);

      if (offer && offer.peerId === userId) {
        fileOffers.delete(fileId);
        socket.broadcast.emit("file-removed", { fileId });
      }
    });

    // Handle errors
    socket.on("error", (error) => {
      console.log(` Socket error for ${userId}:`, error);
    });

    // Handle disconnection
    socket.on("disconnect", (r) => {
      console.log(` Peer disconnected:${r}`);

      // Remove peer's file offers
      const peer = peers.get(userId);
      if (!peer) return;
      if (peer && peer.files) {
        peer.files.forEach((file) => {
          fileOffers.delete(file.fileId);
          socket.broadcast.emit("file-removed", { fileId: file.fileId });
        });
      }

      peer.disconnectedAt = Date.now();
      peer.online = false;

      // Notify others
      socket.broadcast.emit("peer-left", {
        peerId: userId,
        totalPeers: peers.size,
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
