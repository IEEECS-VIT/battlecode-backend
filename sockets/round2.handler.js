import redis from "../config/redis";
import {prisma} from "../config/prisma";

const LEVEL_TIME_LIMIT_MS = {
  easy: 10 * 60 * 1000,
  medium: 20 * 60 * 1000,
  hard: 30 * 60 * 1000,
};

const LEVEL_POINTS = {
  easy: 50,
  medium: 100,
  hard: 150,
};

const FIRST_SOLVE_BONUS = 50;

export const round2Handler = (io, socket) => {
    const handleClientMessage = (payload, callback) => {
      console.log(
        `Message from client ${socket.id} (User: ${socket.user.id}): "${payload.message}"`
      );
  
      socket.emit("server:messageReceived", {
        confirmation: `We received your message: "${payload.message}"`,
      });
  
      if (callback) {
        callback({ success: true, status: "Message handled by server." });
      }
    };

    //1.round2:join(Client -> Server)

    const handleLobbyJoin=async (callback)=>{
      try{
        const userId=socket.user.id;
        const lobbyId="round2:lobby"; //defining sorted redis set for the lobby

        //fetching round 1 scores from redis
        const round1Score=await redis.hget("round1:scores",userId);
        if(!round1Score){
          return callback({success:false,message:"Round 1 score of player not found."});
        }

        await redis.zadd(lobbyId, { score: round1Score, value: userId }); //store users on the basis of round1 score in the ss
        socket.join(lobbyId); 
        socket.join(userId); //join personal room for targeted emits
        io.to(lobbyId).emit("Player joined",userId);
        await redis.set(`round2:lastActive:${userId}`, Date.now()); 

        callback({success:true});
      }catch(err){
        console.error("Error in handleLobbyJoin handler",err);
        callback({success:false,message:"Server error"});

      }
    }

    //2.round2:Start (Client -> Server) - starts round, timer and assigns roles

    const handleStart = async (callback)=>{
      try{
        const lobbyId="round2:lobby";

        if(!socket.user.isAdmin){
          return callback({success:false,message:"User not authorized"});
        }

        await redis.set("round2:started","true");
        const endTime = Date.now() + 90*60*1000;
        await redis.set("round2:endTime",endTime);

        const players = await redis.zrevrange(lobbyId,0,-1,"WITHSCORES"); //returns with scores in desc order
        const totalPlayers = players.length/2; //an array [user,score,user,score] type was returned
        const eliteCount=Math.ceil(totalPlayers*0.3); //rounds up

        let elites =[];
        let challengers=[];

        for(let i=0;i<totalPlayers;i++)
        {
          const playerId=players[i*2];
          const role = i<eliteCount ? "elite":"challenger";

          await redis.hset(`round2:roles`,playerId,role);
          await redis.set(`round2:lastActive:${playerId}`, Date.now());

          io.to(playerId).emit("round2:rolesAssigned", { role });

          if (i < eliteCount) elites.push(playerId);
          else challengers.push(playerId);
        }

        io.to(lobbyId).emit("round2:start",{
          message:"Round 2 starts now. All the best players.",
          endTime,
          elites,
          challengers,
        });

        callback({success:true});
      }catch(err){
        console.error("Error in handleStart",err);
        callback({success:false,message:"Server error"});
      }
    }

    //3.round2:handleBountyStart (client -> start) - gets all the questions and emits to all
    const handleBountyStart = async(callback)=>{
      try{
        const userId = socket.user.id;
        const lobbyId = "round2:lobby";
        
        //fetch random questions
        const questions = await prisma.bountyQuestion.findMany({
          select:{ id: true, title: true, level: true, description: true },
          orderBy: { id: "asc" },
        });

        callback({ success: true, questions });

        io.to(lobbyId).emit("round2:bountyStart",{questions})

      }catch(err){
        console.error("Error in bountyStart handler",err);
        callback({success:false,message:"Could not start bounty."});
      }
    }

    //4.handleBountyBeginQuestion - when 1 question selected
    const handleBountyBeginQuestion = async (payload,callback)=>{
      try{
        const userId = socket.user.id;
        const {questionId}=payload;

        const question=await prisma.bountyQuestion.findUnique({
          where:{id:questionId},
          select:{id:true,level:true}
        })

        if(!question){
          return callback({success:false,message:"Question not found."});
        }

        const timeLimit=LEVEL_TIME_LIMIT_MS[question.level];
        const startTime = Date.now();
        const endTime = startTime + timeLimit;

        const sessionKey=`round2:bounty:${userId}:${questionId}`;
        await redis.hset(sessionKey, {
          status: "active",
          questionId,
          startTime,
          endTime,
        });

        callback({ success: true, questionId, startTime, endTime });
        io.to(userId).emit("round2:bountyBeginQuestion", { questionId, endTime });
      }catch(err){
        console.error("Error in handleBountyBeginQuestion:", err);
        callback({ success: false, message: "Could not start question." });
      }
    }

    //5.round2:bountyProgress (frontend needs to emit periodically)
    const bountyProgress = async(payload,callback)=>{
      try{
        const userId=socket.user.id;
        const { questionId, code } = payload;
        const sessionKey = `round2:bounty:${userId}:${questionId}`;
        

        const session = await redis.hgetall(sessionKey);

        if (!session || session.status !== "active") {
            return callback?.({ success: false, message: "No active bounty session" }); //called only if it exists
        }

        await redis.hset(sessionKey, { codeSnapshot: code }); //autosave
        await redis.set(`round2:lastActive:${userId}`, Date.now());
        callback?.({ success: true });

      }catch(err){
        console.error("Error in bountyProgress:", err);
        callback?.({ success: false, message: "Server error" });
      }
    }

    //6.bounty suggestion (server -> client ) - when inactive for over 5 mins
    const suggestBounty = async(userId)=>{
      try{
        const lastActive=await redis.get(`round2:lastActive:${userId}`);
        if(!lastActive) return;

        const idleTime = Date.now()-parseInt(lastActive);
        if(idleTime>5*60*1000)
        {
          io.to(userId).emit("round2:bountySuggestion",{
            message:"You've been inactive for a while there. Maybe try bounty questions to boost your scores."
          });
        }

      }catch(err){
        console.error("Error in suggestBounty handler: ",err);
      }
    }

    //socket events
    socket.on("client:sendMessage", handleClientMessage); 

    //basic sockets

    //lobby sockets
    socket.on("round2:Join",handleLobbyJoin); 
    socket.on("round2:Start",handleStart); 

    //bounty sockets
    socket.on("round2:bountyStart",handleBountyStart); 
    socket.on("round2:bountyProgress",bountyProgress); 
    socket.on("bounty:questionStart",handleBountyBeginQuestion);
    
    //elite vs challenger sockets
   
  };
  
//TO DO: 1. make the timer persistant 
//2. submit logic me integrate first submit + scoring + leaderboard update


