import express from "express";
// import { connectRedis } from "./connection.js";
import {initializeSocket} from "./socketHandler.js";
import dotenv from "dotenv";
dotenv.config();
import http from "http";
const app = express();
const server = http.createServer(app);

const startServer = async () => {
  try {
    // await connectRedis();
    const port = process.env.PORT ||3002;
    // const port=3005

    initializeSocket(server);

    server.listen(port, () => {
      console.log(`✅ Server running at http://localhost:${port}`);
    });
  } catch (err) {
    console.log("❌ Failed to start server:", err);
    process.exit(1);
  }
};

startServer();
