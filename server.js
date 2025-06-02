const express = require("express");
const app = express();
const router= require('../battlecode project/routes/allroutes');

//implementing sockets for room creation
const { createServer } = require("http");
const { Server } = require("socket.io");
const httpServer = createServer(app);  //creates httpserver
const io = new Server(httpServer, {}); //creates socket server

const initializeSocket = require("./sockets/socket");
initializeSocket(io); 

app.use(express.urlencoded({ extended: true }));

//route
app.use('/api',router)

app.get("/", (req, res) => {
  res.send("BattleCode Backend");
});

httpServer.listen(8080, () => {
  console.log("Server is running on port 8080");
});






