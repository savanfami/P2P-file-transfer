import { Server } from "socket.io";

const peers = new Map();
const fileOffers = new Map();
const roomPeers = new Map();

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
    const { userId, roomCode } = socket.handshake.query;

    if (!userId || !roomCode) {
      socket.emit("error", { message: "Missing userId or roomCode" });
      socket.disconnect(true);
      return;
    }

    // Join room
    socket.join(roomCode);

    // Track room membership
    if (!roomPeers.has(roomCode)) roomPeers.set(roomCode, new Set());
    const members = roomPeers.get(roomCode);
    members.add(userId);

    // Track peer
    const existingPeer = peers.get(userId);
    if (existingPeer) {
      existingPeer.socketId = socket.id;
      existingPeer.reconnectedAt = Date.now();
      existingPeer.online = true;
      existingPeer.roomCode = roomCode;
      peers.set(userId, existingPeer);
      socket.emit("peers-list", {
        peers: Array.from(members).filter((id) => id !== userId),
        totalPeers: members.size,
      });
      console.log('emitted')

      socket.to(roomCode).emit("peer-reconnected", { peerId: userId });
      console.log(`🔄 Peer reconnected: ${userId} in room ${roomCode}`);
    } else {
      peers.set(userId, {
        socketId: socket.id,
        connectedAt: Date.now(),
        files: [],
        roomCode,
      });
      console.log(`🆕 New peer connected: ${userId} in room ${roomCode}`);
      socket.emit("peers-list", {
        peers: Array.from(members).filter((id) => id !== userId),
        totalPeers: members.size,
      });
    }

    // Send existing file offers in room
    const currentOffers = Array.from(fileOffers.values()).filter(
      (f) => f.roomCode === roomCode
    );
    if (currentOffers.length) socket.emit("initial-file-offers", currentOffers);

    socket.to(roomCode).emit("peer-joined", {
      peerId: userId,
      totalPeers: members.size,
    });

    // Handle WebRTC signaling (only within room)
    socket.on("signal", (data) => {
      const { to, signal, type } = data;
      if (!to) return;

      const target = peers.get(to);
      if (!target || target.roomCode !== roomCode) return;

      io.to(target.socketId).emit("signal", {
        signal,
        from: userId,
        type,
      });
    });

    // File offer (within room)
    socket.on("file-offer", (data) => {
      const files = Array.isArray(data) ? data : [data];

      files.forEach((file) => {
        const { fileName, fileSize, fileType, fileId } = file;
        if (!fileName || !fileSize) return;

        const offer = {
          fileId: fileId || `${userId}-${Date.now()}`,
          fileName,
          fileSize,
          fileType,
          peerId: userId,
          roomCode,
          offeredAt: Date.now(),
        };

        fileOffers.set(offer.fileId, offer);

        const peer = peers.get(userId);
        if (peer) {
          if (!Array.isArray(peer.files)) peer.files = [];
          peer.files.push(offer);
        }

        socket.to(roomCode).emit("file-available", offer);
      });
    });


    socket.on("exit-room", (data) => {
      const { userId, roomCode } = data;
      console.log(`🚪 Peer exited room manually: ${userId} (${roomCode})`);

      const peer = peers.get(userId);
      if (peer) {
        // Remove file offers made by this peer
        if (peer.files) {
          peer.files.forEach((file) => {
            fileOffers.delete(file.fileId);
            socket.to(roomCode).emit("file-removed", { fileId: file.fileId });
          });
        }

        // Remove from peers and room
        peer.online = false;
        peers.delete(userId);
      }

      const members = roomPeers.get(roomCode);
      if (members) {
        members.delete(userId);
        if (members.size === 0) roomPeers.delete(roomCode);
      }

      socket.leave(roomCode);
      socket.to(roomCode).emit("peer-left", { peerId: userId });

      // Clean close of socket
      socket.disconnect(true);
    });

    // Remove file offer
    socket.on("remove-file-offer", (data) => {
      const { fileId } = data;
      const offer = fileOffers.get(fileId);

      if (offer && offer.peerId === userId) {
        fileOffers.delete(fileId);
        socket.to(roomCode).emit("file-removed", { fileId });
      }
    });

    // Error handling
    socket.on("error", (error) => {
      console.log(`⚠️ Socket error for ${userId}:`, error);
    });

    // Handle disconnect
    socket.on("disconnect", (reason) => {
      console.log(`❌ Peer disconnected: ${userId} (${reason})`);

      const peer = peers.get(userId);
      if (!peer) return;

      // Remove their offers
      if (peer.files) {
        peer.files.forEach((file) => {
          fileOffers.delete(file.fileId);
          socket.to(roomCode).emit("file-removed", { fileId: file.fileId });
        });
      }

      // Update peer state
      peer.disconnectedAt = Date.now();
      peer.online = false;

      // Remove from room
      const members = roomPeers.get(roomCode);
      if (members) {
        members.delete(userId);
        if (members.size === 0) roomPeers.delete(roomCode);
      }

      socket.to(roomCode).emit("peer-left", {
        peerId: userId,
        totalPeers: members ? members.size : 0,
      });
    });
  });

  // Cleanup old file offers (every 5 min)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 mins
    for (const [fileId, offer] of fileOffers.entries()) {
      if (now - offer.offeredAt > maxAge) {
        fileOffers.delete(fileId);
        io.to(offer.roomCode).emit("file-removed", { fileId });
        console.log(`🗑️ Cleaned up old file offer: ${fileId}`);
      }
    }
  }, 5 * 60 * 1000);

  console.log("✅ Socket.IO initialized with room/session support");
  return io;
};
