import express from 'express'

const app=express()

const port=process.env.port||3002



app.listen(port,()=>{
    console.log(`server running on port http://localhost:${port}`)
})