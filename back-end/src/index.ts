import express from 'express'
import {connectRedis} from './connection.js'
const app=express()

await connectRedis()


const port=process.env.PORT||3002



app.listen(port,()=>{
    console.log(`server running on port http://localhost:${port}`)
}) 