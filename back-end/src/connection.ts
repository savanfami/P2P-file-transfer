import { createClient } from 'redis';
import dotenv from 'dotenv'
dotenv.config();

const client = createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.PASSWORD,
    socket: {
        host: process.env.HOST,
        port: process.env.REDIS_PORT as any
    } 
});
 
client.on('error', err => console.log('Redis Client Error', err));

export async function connectRedis() {
    await client.connect(); 
    console.log('✅ Connected to Redis'); 
} 

 


