
import redis from "../config/redis.js";
import {prisma} from "../config/database.js"

// round0_handler.js

const REDIS_KEY = 'round0';
export const round0Handler = (io, socket) => {
  // Handle generic client message
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
  


  //fetch for round 0
  const fetchProblem = async (payload, callback) => {
    try {
      const {limit = 1 } = payload || {};   //all keys with pairs defined in payload will be given to the variables difficulty, catgeories, limit

        const problems = await prisma.problem.findMany({
          where: {
            roundId: 0
          },
          take: limit
      
        });
        const userId = socket.user?.id;
        if (!userId) {
          if (callback) callback({ success: false, error: 'Unauthorized' });
          return;
        }

      if (!problems || problems.length === 0) {
        if (callback) callback({ success: false, error: 'No problems found' });
        return;
      }


      // Emit to frontend with 'problemFetched'
      socket.emit('problemFetched', { problem: problems[0] });

      
      const redisKeyProblems = `round0:problems:${userId}`;
      const redisKeyCurrentIndex = `round0:currentIndex:${userId}`;

      // Store problems as JSON string
      await redis.setex(redisKeyProblems, 86400, JSON.stringify(problems)); // expire in 1 day
      await redis.set(redisKeyCurrentIndex, 0); // start with first problem index

      if (callback) callback({ success: true, problem: problems[0] });  // the callback function is what will send the 
    } catch (error) {
      console.error('Error fetching problem:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  };

  
  

  // Join lobby 
  const joinLobby = async (payload, callback) => {
    try {
      const userId = socket.user?.id;
      if (!userId) {
        return callback?.({ success: false, error: 'Unauthorized' });
      }

      const joinedAt = new Date().toISOString();

      // Store participant info in Redis hash
      await redis.hset(REDIS_KEY, userId, JSON.stringify({
        status: 'LOBBY',
        joinedAt,
      }));

      // Set a TTL key for presence expiry management
      await redis.setex(`round0:user:${userId}`, 86400, 'online'); // expires in 1 day

      // Fetch all active participants for lobby sync
      const allParticipantsRaw = await redis.hgetall(REDIS_KEY);
      const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
        userId: uid,
        ...JSON.parse(value),
      }));

      // Optionally broadcast updated lobby to all connected Round 0 sockets
      io.emit('lobbyUpdate', { lobbyParticipants });

      // Respond to the joining client
      callback?.({ success: true, lobbyParticipants });
    } catch (error) {
      console.error('Round 0 join (socket) error:', error);
      callback?.({ success: false, error: 'Failed to join Round 0' });
    }
  };

  // Leave lobby (equivalent to /leave HTTP POST)
  const leaveLobby = async (payload, callback) => {
    try {
      const userId = socket.user?.id;
      if (!userId) {
        return callback?.({ success: false, error: 'Unauthorized' });
      }

      // Remove user from Redis hash and presence TTL key
      await redis.hdel(REDIS_KEY, userId);
      await redis.del(`round0:user:${userId}`);

      // Fetch lobby participants after removal
      const allParticipantsRaw = await redis.hgetall(REDIS_KEY);
      const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
        userId: uid,
        ...JSON.parse(value),
      }));

      // Broadcast updated lobby to all connected sockets
      io.emit('lobbyUpdate', { lobbyParticipants });

      callback?.({ success: true, message: 'Left Round 0 lobby' });
    } catch (error) {
      console.error('Round 0 leave (socket) error:', error);
      callback?.({ success: false, error: 'Failed to leave Round 0' });
    }
  };

  // Register socket event listeners
  
  

  const lobby = async() => {
    const allParticipantsRaw = await redis.hgetall(REDIS_KEY);
    const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
      userId: uid,
      ...JSON.parse(value),
      }));
    io.emit('lobby', lobbyParticipants);
  
  }
  

  const nextProblem = async(_,callback) =>{ 
    const userId = socket.user?.id;     
    const redisKeyProblems = `round0:problems:${userId}`;
    const redisKeyCurrentIndex = `round0:currentIndex:${userId}`;

    const problemsJson = await redis.get(redisKeyProblems);
    const problems = JSON.parse(problemsJson);
  
    let currentIndex = parseInt(await redis.get(redisKeyCurrentIndex)) || 0;
    currentIndex += 1;    

    if (currentIndex < problems.length) {
    await redis.set(redisKeyCurrentIndex, currentIndex);
    const nextProblem = problems[currentIndex];
    socket.emit('nextProblem', { problem: nextProblem, problemIndex: currentIndex });
    if (callback) callback({ success: true, problem: nextProblem });
  } 
  else {
    if (callback) callback({ success: false, error: 'No more problems' });
  }
}


  

const reconnectRound0 = async (payload, callback) => {
    try {
      const userId = socket.user?.id;

      // Fetch user-specific game state from Redis
      // Assuming game state stored under keys like: round0:state:<userId>
      const gameStateRaw = await redis.get(`round0:state:${userId}`);

      if (!gameStateRaw) {
        return callback?.({ success: false, error: "No game state found" });
      }

      const gameState = JSON.parse(gameStateRaw);

      // Gamestate must be like:-
      // {
      //   problems: [...],
      //   currentProblemIndex: number,
      //   timeRemaining: number (seconds)
      // }

      // Emit only to the reconnected user the full game state so they can resume
      socket.emit('round0:reconnect', gameState);

      // Optionally acknowledge success to the client
      
      if (callback) {
        callback?.({ success: true, gameState });
      }


    } catch (error) {
        console.error("Error in round0:reconnect", error);
        
        if (callback) {
          callback({ success: false, error: error.message });
        }
    }
  };

  // Reconnect event listener
  
  
  const round_duration = 1800;   //this is in seconds not in milliseconds unlike date.now
  let roundStartTime = null;
  let timerInterval = null;

  const startTimer = () => {
    roundStartTime = Date.now();

    if (timerInterval) clearInterval(timerInterval);

    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - roundStartTime) / 1000);
      const timeRemaining = round_duration - elapsed;

      if (timeRemaining <= 0) {
        clearInterval(timerInterval);
        io.emit('round0:timer', { timeRemaining: 0 });
        io.emit('round0:end');
      } else {
        io.emit('round0:timer', { timeRemaining });
      }
    }, 1000);       //Set Interval to 1000 milliseconds
  };

    
  const disconnect_handler = async () => {
    try {
      const userId = socket.user?.id;
      if (!userId) return;

      // Fetch participant from Redis
      const participantRaw = await redis.hget(REDIS_KEY, userId);
      if (!participantRaw) return;

      const participant = JSON.parse(participantRaw);
      participant.status = "disconnected";
      participant.disconnectedAt = new Date().toISOString();

      // Update the value in Redis
      await redis.hset(REDIS_KEY, userId, JSON.stringify(participant));

      // Calc time remaining
      let timeRemaining = 0;
      if (roundStartTime) {
        const elapsed = Math.floor((Date.now() - roundStartTime) / 1000); // in seconds
        timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);
      }

      // Compose participants list for broadcast
      const allRaw = await redis.hgetall(REDIS_KEY);
      const lobbyParticipants = Object.entries(allRaw).map(([uid, value]) =>
        ({ userId: uid, ...JSON.parse(value) })
      );

      // Emit updated lobby (with timeRemaining!)
      io.emit("lobbyUpdate", {
        participants: lobbyParticipants,
        timeRemaining
      });

    } catch (err) {
      console.error("Error in Round 0 disconnect handler:", err);
    }
  }

  

  const start_round0 = async() =>{
    const problems = await prisma.problem.findMany({
      where: {
        roundId: 0
      }
      
  });
    io.emit('start_round0', {problems, round0_duation : 1800});
  }
    


    socket.on("client:sendMessage", handleClientMessage);
    socket.on('fetchProblem', fetchProblem);
    socket.on('round0:join', joinLobby);
    socket.on('round0:leave', leaveLobby);
    socket.on('lobby',lobby);
    socket.on('nextProblem', nextProblem);
    socket.on('round0:reconnect', reconnectRound0);
    socket.on('round0:start', startTimer);
    socket.on('disconnect', disconnect_handler);
    socket.on('start_round0', start_round0);
};


