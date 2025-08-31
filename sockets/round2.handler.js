import redis from "../config/redis";
import {prisma} from "../config/prisma";

const LEVEL_TIME_LIMIT_MS = {
  easy: 10 * 60 * 1000,
  medium: 20 * 60 * 1000,
  hard: 30 * 60 * 1000,
};

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

          await redis.set(`round2:role:${playerId}`, role);
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

    //7.challenge request (client -> server)
    const handleChallengeRequest=async(payload,callback)=>{
      try{
        const challengerId=socket.user.id;
        const { eliteId } = payload;

        //verify roles
        const [challengerRole,eliteRole]=await redis.mget(`round2:role:${challengerId}`,`round2:role:${eliteId}`);

        if(challengerRole!=="challenger")
        {
          return callback?.({success:false,message:"Only challengers can send match requests"});
        }

        if(eliteRole!=="elite")
        {
          return callback?.({success:false,message:"Only elites can be challenged for matches"});
        }

        //check status
        const [challengerStatus,eliteStatus]=await Promise.all([
          redis.get(`round2:status:${challengerId}`),
          redis.get(`round2:status:${eliteId}`),
        ]);

        if(challengerStatus==="inMatch")
        {
          return callback?.({success:false,message:"You are already lined up for a match."});
        }

        if(eliteStatus==="inMatch")
        {
          return callback?.({success:false,message:"Cannot challenge an elite when they are in match."});
        }

        const challengerCooldownKey = `round2:cooldown:${challengerId}`;
        const isChallengerCooldown = await redis.exists(challengerCooldownKey);

        if (isChallengerCooldown) {
          return callback({
            success: false,
            message: "You are in cooldown. Try again later."
          });
        }

        const eliteCooldownKey = `round2:cooldown:${eliteId}`;
        const isEliteCooldown = await redis.exists(eliteCooldownKey);

        if (isEliteCooldown) {
          return callback({
          success: false,
          message: "Elite is currently in cooldown. Try again later."
          });
        }

        const requestKey = `round2:request:${challengerId}:${eliteId}`;
        const pendingZ = `round2:pending:${eliteId}`; //elite's sorted set of reqs
        const outgoingSet= `round2:outgoing:${challengerId}`;

        const requestData = {challengerId,eliteId,createdAt:Date.now()};
        const setResult = await redis.set(requestKey,JSON.stringify(requestData),{
          NX:true, //only sets key if it doesn't exist already
          EX:30,
        })

        if(!setResult)
        {
          return callback?.({success:false,message:"You already have an active request to this elite."});
        }

        await redis
        .multi() //creates queue of commands to be run together
        .zadd(pendingZ,{score:Date.now(),value:challengerId}) //chronoligically arranged reqs
        .sadd(outgoingSet,eliteId) 
        .expire(outgoingSet,40) //to ensure autodelete post expiration of req
        .expire(pendingZ, 300) // auto-clean elite’s pending request queue
        .exec();

        io.to(eliteId).emit("round2:challengeIncoming",{challengerId,expiresIn:30});

        return callback?.({success:true,message:"Challenge request sent."});

      }catch(err){
        console.error("Error in handleChallengeRequest",err);
        callback({success:false,message:"Server error"});
      }
    }

    //8.AcceptChallenges (Server->Client)

    const handleChallengeAccept = async(payload,callback)=>{
      try{
        const eliteId = socket.user.id;
        const {challengerId} = payload;

        const requestKey=`round2:request:${challengerId}:${eliteId}`;
        const requestData = await redis.get(requestKey);
        if(!requestData)
        {
          return callback?.({success:false,message:"No active request found."});
        }

        //rechecking roles and status before assigning match
        const [eliteRole, challengerRole] = await redis.mget(
          `round2:role:${eliteId}`,
          `round2:role:${challengerId}`
        );

        if (eliteRole !== "elite" || challengerRole !== "challenger") {
          return callback?.({ success: false, message: "Invalid roles." });
        }

        const [eliteStatus, challengerStatus, eliteCooldown, challengerCooldown] = await Promise.all([
        redis.get(`round2:status:${eliteId}`),
        redis.get(`round2:status:${challengerId}`),
        redis.exists(`round2:cooldown:${eliteId}`),
        redis.exists(`round2:cooldown:${challengerId}`),
      ]);

        if (eliteStatus === "inMatch" || eliteCooldown) {
          return callback?.({ success: false, message: "Elite unavailable." });
        }
        if (challengerStatus === "inMatch" || challengerCooldown) {
          return callback?.({ success: false, message: "Challenger unavailable." });
        }

        const matchId=`match:${challengerId}:${eliteId}:${Date.now()}`;

        const allQuestions= await prisma.round2Questions.findMany();
        const randomQuestion=allQuestions[Math.floor(Math.random()*allQuestions.length)];

        await redis.multi()
        .zrem(`round2:pending:${eliteId}`,challengerId) //removes accepted challenger from queue
        .srem(`round2:outgoing:${challengerId}`, eliteId)
        .del(requestKey)
        .set(`round2:status:${challengerId}`, "inMatch", "EX", 2400)
        .set(`round2:status:${eliteId}`, "inMatch", "EX", 2400)
        .set(`round2:match:${matchId}`,JSON.stringify({challengerId,eliteId,createdAt:Date.now(),question:randomQuestion}),"EX",1200)
        .exec()

        //auto-reject unaccepted requests
        const pendingKey = `round2:pending:${eliteId}`;
        const pending = await redis.zrange(pendingKey, 0, -1); 

        for (const otherChallengerId of pending) 
        {
          if (otherChallengerId === challengerId) continue; 

          const otherRequestKey = `round2:request:${otherChallengerId}:${eliteId}`;
          const outgoingKey = `round2:outgoing:${otherChallengerId}`;

          await redis
          .multi()
          .del(otherRequestKey)
          .zrem(pendingKey, otherChallengerId)
          .srem(outgoingKey, eliteId)
          .exec();
        
          io.to(otherChallengerId).emit("round2:challengeRejected", {
            eliteId,
            challengerId: otherChallengerId,
            reason: "Elite accepted another challenge",
          });
        }

        io.to(challengerId).emit("round2:challengeAccepted", { eliteId, matchId });
        io.to(eliteId).emit("round2:challengeAccepted", { challengerId, matchId });

        //server->client
        io.to(challengerId).emit("round2:matchStarted",{
          matchId,
          opponent:eliteId,
          question:randomQuestion,
        });

        io.to(eliteId).emit("round2:matchStarted",{
          matchId,
          opponent:challengerId,
          question:randomQuestion,
        });

        callback?.({ success: true, message: "Challenge accepted.", matchId });

        const MATCH_DURATION_MS=20*60*1000;

        setTimeout(async()=>{
          const scores=await redis.hgetall(`round2:scores:${matchId}`);
          const challengerScore=parseInt(scores[challengerId] || 0, 10);
          const eliteScore = parseInt(scores[eliteId] || 0, 10);

          let winner,loser;

          if(challengerScore>eliteScore)
          {
            winner=challengerId;
            loser=eliteId;
          }else if (eliteScore > challengerScore) {
            winner = eliteId;
            loser = challengerId;
          } else {
            //
            winner = null;
          }

          io.to(challengerId).emit("round2:matchResult", {
            challengerScore,
            eliteScore,
            winner,
          });

          io.to(eliteId).emit("round2:matchResult", {
            challengerScore,
            eliteScore,
            winner,
          })

          await redis.setex(`round2:cooldown:${challengerId}`, 120, "1");
          await redis.setex(`round2:cooldown:${eliteId}`, 120, "1");

          io.to(challengerId).emit("round2:cooldown", { duration: 120 });
          io.to(eliteId).emit("round2:cooldown", { duration: 120 });

          await redis.del(`round2:status:${challengerId}`);
          await redis.del(`round2:status:${eliteId}`);

          console.log(`Match ${matchId} finished → Challenger(${challengerScore}) vs Elite(${eliteScore})`);

        },MATCH_DURATION_MS);
      }catch(err){
        console.error("Error in handleChallengeAccepted", err);
        callback?.({ success: false, message: "Server error" });
      }
    }

    //9.Reject Challenges (Server->Client)

    const handleChallengeReject = async(payload,callback)=>{
      try{
        const eliteId=socket.user.id;
        const {challengerId}=payload;

        const requestKey=`round2:request:${challengerId}:${eliteId}`;
        const requestData = await redis.get(requestKey);
        if(!requestData)
        {
          return callback?.({success:false,message:"No active request found."});
        }

        await redis.multi()
        .zrem(`round2:pending:${eliteId}`, challengerId)
        .srem(`round2:outgoing:${challengerId}`, eliteId)
        .del(requestKey)
        .exec();

        io.to(challengerId).emit("round2:challengeRejected", { eliteId });
        return callback?.({ success: true, message: "Challenge rejected." });

      }catch(err){
        console.error("Error in handleChallengeRejected", err);
        return callback?.({ success: false, message: "Server error" });
      }
    }

    //10.EndRound2 - informs round 2 has ended

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
    socket.on("round2:challengeRequest",handleChallengeRequest);
    socket.on("round2:challengeReject",handleChallengeReject);
    socket.on("round2:challengeAccept",handleChallengeAccept);
   
  };
  
//TO DO: 1. make the timer persistant 
//2. submit logic me integrate first submit + scoring + leaderboard update
//3.logic for if match is a tie


