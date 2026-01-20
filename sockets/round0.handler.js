import redis from "../config/redis.js";
import prisma from "../config/prisma.js";

/**
 * ROUND 0 SOCKET HANDLER
 * 
 * CLIENT → SERVER EVENTS:
 * - round0:join - Join round lobby
 * - round0:ready - Start round (admin only)
 * - round0:nextQuestion - Move to next problem
 * - round0:getState - Get current game state
 * - round0:reset - Reset round (admin only)
 * - disconnect - Handle user disconnect
 * 
 * SERVER → CLIENT EVENTS:
 * - lobby:round0 - Lobby participant updates
 * - round0:start - Round started with problems
 * - round0:reconnect - Reconnection data
 * - round0:timer - Timer updates
 * - round0:end - Round ended
 * 
 * REDIS KEYS:
 * - round0:lobby - Hash of participants {userId: participantData}
 * - round0:state:{userId} - User game state
 * - round0:progress:{userId} - User progress
 * - round0:timer:global - Round timer
 * - round0:problems - Round problems
 * - round0:user:{userId} - User presence
 */

const ROUND_DURATION = 60*1;
const ROUND_NUMBER = 0;

let globalRoundState = {
  isActive: false,
  startTime: null,
  participants: new Map(),
  timerInterval: null,
  problems: []
};

const getRedisKeys = (userId = null) => ({
  lobby: `round${ROUND_NUMBER}:lobby`,
  state: userId ? `round${ROUND_NUMBER}:state:${userId}` : null,
  progress: userId ? `round${ROUND_NUMBER}:progress:${userId}` : null,
  timer: `round${ROUND_NUMBER}:timer:global`,
  problems: `round${ROUND_NUMBER}:problems`,
  presence: userId ? `round${ROUND_NUMBER}:user:${userId}` : null
});

const initializeGlobalState = () => {
  globalRoundState.isActive = false;
  globalRoundState.startTime = null;
  globalRoundState.participants.clear();
  globalRoundState.problems = [];
  
  if (globalRoundState.timerInterval) {
    clearInterval(globalRoundState.timerInterval);
    globalRoundState.timerInterval = null;
  }
};

const resetRoundState = async () => {
  try {
    initializeGlobalState();
    
    const keys = getRedisKeys();
    const allParticipantsRaw = await redis.hgetall(keys.lobby);
    const resetPipeline = redis.pipeline();
    
    for (const [participantId, participantDataRaw] of Object.entries(allParticipantsRaw)) {
      const participantData = JSON.parse(participantDataRaw);
      participantData.status = 'WAITING';
      resetPipeline.hset(keys.lobby, participantId, JSON.stringify(participantData));
      
      const userKeys = getRedisKeys(participantId);
      resetPipeline.del(userKeys.state);
      resetPipeline.del(userKeys.progress);
    }
    
    resetPipeline.del(keys.problems);
    resetPipeline.del(keys.timer);
    
    await resetPipeline.exec();
    return true;
  } catch (error) {
    console.error('Error resetting round state:', error);
    return false;
  }
};

initializeGlobalState();

// Move broadcastLobbyUpdate outside handler so it can be accessed by admin functions
const broadcastLobbyUpdate = async (io) => {
  try {
    // Check database status to ensure consistency
    const round0DB = await prisma.round.findUnique({
      where: { roundNumber: 0 }
    });

    // Sync in-memory state with database
    if (round0DB) {
      const dbIsActive = round0DB.status === 'IN_PROGRESS';
      if (dbIsActive !== globalRoundState.isActive) {
        console.log(`Syncing in-memory state with database: DB=${round0DB.status}, Memory=${globalRoundState.isActive ? 'ACTIVE' : 'INACTIVE'}`);
        if (!dbIsActive) {
          initializeGlobalState();
        }
      }
    }

    const keys = getRedisKeys();
    const allParticipantsRaw = await redis.hgetall(keys.lobby);
    const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
      userId: uid,
      ...JSON.parse(value)
    }));

    // Calculate remaining time
    let timeRemaining = 0;
    if (globalRoundState.isActive && globalRoundState.startTime) {
      const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
      timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);
    }

    io.to('round0').emit('lobby:round0', {
      participants: lobbyParticipants,
      totalParticipants: lobbyParticipants.length,
      isActive: globalRoundState.isActive,
      timeRemaining,
      databaseStatus: round0DB?.status || 'UNKNOWN'
    });
  } catch (error) {
    console.error('Error broadcasting lobby update:', error);
  }
};

export const round0Handler = (io, socket) => {
  
  // UTILITY FUNCTIONS
  
  const validateUser = () => {
    const userId = socket.user?.email;  // userId stores email (consistent with Round 1)
    if (!userId) {
      return { error: 'Unauthorized - No user email' };
    }
    return { userId, email: userId };  // Both reference the same email value
  };

  const startGlobalTimer = (io) => {
    if (globalRoundState.timerInterval) {
      clearInterval(globalRoundState.timerInterval);
    }

    globalRoundState.timerInterval = setInterval(async () => {
      try {
        const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
        const timeRemaining = ROUND_DURATION - elapsed;

        if (timeRemaining <= 0) {
          clearInterval(globalRoundState.timerInterval);
          globalRoundState.isActive = false;
          
          try {
            await prisma.round.update({
              where: { roundNumber: 0 },
              data: { status: 'COMPLETED' }
            });
          } catch (error) {
            console.error('Error updating Round 0 database status to COMPLETED:', error);
          }
          
          io.to('round0').emit('round0:end', {
            message: 'Round 0 has ended!',
            duration: ROUND_DURATION,
            totalParticipants: globalRoundState.participants.size
          });

          const keys = getRedisKeys();
          const allParticipantsRaw = await redis.hgetall(keys.lobby);
          for (const [participantId, participantDataRaw] of Object.entries(allParticipantsRaw)) {
            const participantData = JSON.parse(participantDataRaw);
            participantData.status = 'FINISHED';
            participantData.finishedAt = new Date().toISOString();
            await redis.hset(keys.lobby, participantId, JSON.stringify(participantData));
          }
        } else {
          io.to('round0').emit('round0:timer', {
            timeRemaining,
            elapsed,
            duration: ROUND_DURATION
          });
        }
      } catch (error) {
        console.error('Error in global timer:', error);
      }
    }, 1000);
  };

  const syncGlobalStateWithRedis = async () => {
    try {
      const keys = getRedisKeys();
      const timerRaw = await redis.get(keys.timer);
      const problemsRaw = await redis.get(keys.problems);
      
      if (timerRaw && problemsRaw) {
        const startTime = parseInt(timerRaw);
        const problems = JSON.parse(problemsRaw);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        
        if (elapsed < ROUND_DURATION) {
          globalRoundState.isActive = true;
          globalRoundState.startTime = startTime;
          globalRoundState.problems = problems;
          startGlobalTimer(io);
        } else {
          initializeGlobalState();
        }
      } else {
        initializeGlobalState();
      }
    } catch (error) {
      console.error('Error syncing global state with Redis:', error);
      initializeGlobalState();
    }
  };

  // CLIENT → SERVER EVENT HANDLERS

  // Handle round0:join
  const handleJoinLobby = async (payload, callback) => {
    let userData = null;
    let participantData = null;
    let redisOperationsExecuted = false;
    
    try {
      const { userId,email, error } = validateUser();
      
      if (error) {
        return callback?.({ success: false, error });
      }

      // Check round status from database first
      const round0DB = await prisma.round.findUnique({
        where: { roundNumber: 0 }
      });

      if (!round0DB) {
        return callback?.({ success: false, error: 'Round 0 not found in database' });
      }

      if (round0DB.status !== 'LOBBY') {
        return callback?.({ 
          success: false, 
          error: `Round 0 is not in LOBBY status. Current status: ${round0DB.status}` 
        });
      }

      // Update in-memory state to match database
      if (round0DB.status === 'LOBBY' && globalRoundState.isActive) {
        console.log('Database shows LOBBY but in-memory state shows active. Resetting in-memory state.');
        initializeGlobalState();
      }

      // Step 1: Fetch and validate user data from database first
      try {
        userData = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, role: true }
        });
      } catch (error) {
        console.error('Error fetching user data:', error);
        return callback?.({ success: false, error: 'Failed to fetch user data' });
      }

      if (!userData) {
        return callback?.({ success: false, error: 'User not found in database' });
      }

      const username = userData.username || 'Anonymous';
      const userRole = userData.role || 'USER';
      const joinedAt = new Date().toISOString();
      const keys = getRedisKeys(userId);

      // Step 2: Prepare participant data
      participantData = {
        userId,
        username,
        email,
        role: userRole,
        status: 'WAITING',
        joinedAt,
        isReady: false
      };

      // Step 3: Execute Redis operations atomically
      const redisPipeline = redis.pipeline();
      redisPipeline.hset(keys.lobby, userId, JSON.stringify(participantData));
      redisPipeline.setex(`round${ROUND_NUMBER}:user:${userId}`, 3600, 'online');
      
      try {
        await redisPipeline.exec();
        redisOperationsExecuted = true;
      } catch (error) {
        console.error('Error executing Redis operations for join:', error);
        return callback?.({ success: false, error: 'Failed to join lobby due to Redis error' });
      }

      // Step 4: Get all lobby participants after successful Redis operations
      let allParticipantsRaw;
      try {
        allParticipantsRaw = await redis.hgetall(keys.lobby);
      } catch (error) {
        console.error('Error fetching lobby participants:', error);
        // Rollback: Remove user from lobby
        try {
          await redis.hdel(keys.lobby, userId);
          await redis.del(`round${ROUND_NUMBER}:user:${userId}`);
        } catch (rollbackError) {
          console.error('Error during rollback:', rollbackError);
        }
        return callback?.({ success: false, error: 'Failed to fetch lobby state' });
      }

      const lobbyParticipants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
        userId: uid,
        ...JSON.parse(value)
      }));

      // Step 5: Update global state only after all operations succeed
      globalRoundState.participants.set(userId, participantData);

      // Step 6: Join socket room
      socket.join('round0');
      socket.join(`user:${userId}`);

      // Step 7: Broadcast lobby update to all participants
      await broadcastLobbyUpdate(io);

      console.log(`User ${username} (${userId}) joined Round 0 lobby`);
      
      callback?.({ 
        success: true, 
        message: 'Successfully joined Round 0 lobby',
        participants: lobbyParticipants
      });

    } catch (error) {
      console.error('Error in round0:join:', error);
      
      // Rollback operations if they were executed
      if (redisOperationsExecuted && participantData) {
        try {
          const keys = getRedisKeys(participantData.userId);
          await redis.hdel(keys.lobby, participantData.userId);
          await redis.del(`round${ROUND_NUMBER}:user:${participantData.userId}`);
          console.log('Successfully rolled back Redis operations after join error');
        } catch (rollbackError) {
          console.error('Error during join rollback:', rollbackError);
        }
      }
      
      // Remove from global state if it was added
      if (participantData && globalRoundState.participants.has(participantData.userId)) {
        globalRoundState.participants.delete(participantData.userId);
      }
      
      callback?.({ success: false, error: 'Failed to join Round 0 lobby' });
    }
  };

  // Handle round0:ready (Admin only)
  const handleAdminReady = async (payload, callback) => {
    // Create a Redis transaction pipeline for atomic operations
    const redisPipeline = redis.pipeline();
    let userData = null;
    let problems = null;
    let allParticipantsRaw = null;
    let participantsToUpdate = [];
    
    try {
      const { userId, error } = validateUser();

      if (error) {
        return callback?.({ success: false, error });
      }

      // Check if round is already active (early check)
      if (globalRoundState.isActive) {
        return callback?.({ success: false, error: 'Round 0 is already active' });
      }

      // Check if Round 0 is in LOBBY status in database
      const round0DB = await prisma.round.findUnique({
        where: { roundNumber: 0 }
      });

      if (!round0DB || round0DB.status !== 'LOBBY') {
        return callback?.({ 
          success: false, 
          error: `Round 0 is not in LOBBY status. Current status: ${round0DB?.status || 'Not found'}` 
        });
      }

      // Step 1: Fetch and validate user data from database
      try {
        userData = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, role: true }
        });
      } catch (error) {
        console.error('Error fetching user data:', error);
        return callback?.({ success: false, error: 'Failed to fetch user data' });
      }

      if (!userData) {
        return callback?.({ success: false, error: 'User not found in database' });
      }

      const userRole = userData.role || 'USER';

      if (userRole !== 'ADMIN') {
        return callback?.({ success: false, error: 'Only admins can start Round 0' });
      }

      // Step 2: Fetch problems (this should work or fail early)
      try {
        problems = await prisma.problem.findMany({
          where: { difficulty: 'R0' },
          orderBy: { id: 'asc' }
        });
      } catch (error) {
        console.error('Error fetching problems:', error);
        return callback?.({ success: false, error: 'Failed to fetch Round 0 problems' });
      }

      if (!problems || problems.length === 0) {
        return callback?.({ success: false, error: 'No problems found for Round 0' });
      }

      // Step 3: Get current participants (this should work or fail early)
      const keys = getRedisKeys();
      try {
        allParticipantsRaw = await redis.hgetall(keys.lobby);
      } catch (error) {
        console.error('Error fetching lobby participants:', error);
        return callback?.({ success: false, error: 'Failed to fetch lobby participants' });
      }

      // Step 4: Prepare all Redis operations for atomic execution
      const startTime = Date.now();
      
      // Store problems and timer
      redisPipeline.setex(keys.problems, 3600, JSON.stringify(problems));
      redisPipeline.setex(keys.timer, 3600, startTime.toString());

      // Prepare participant updates
      for (const [participantId, participantDataRaw] of Object.entries(allParticipantsRaw)) {
        const participantData = JSON.parse(participantDataRaw);
        participantData.status = 'IN_MATCH';
        participantsToUpdate.push({ participantId, participantData });
        
        // Update lobby
        redisPipeline.hset(keys.lobby, participantId, JSON.stringify(participantData));
        
        // Initialize user state
        const userState = {
          currentProblemIndex: 0,
          problems,
          startTime: startTime,
          submissions: []
        };
        
        const userKeys = getRedisKeys(participantId);
        redisPipeline.setex(userKeys.state, 3600, JSON.stringify(userState));
        
        // Initialize progress
        const userProgress = {
          problemsSolved: 0,
          currentProblem: 0,
          score: 0,
          lastActivity: new Date().toISOString()
        };
        redisPipeline.setex(userKeys.progress, 3600, JSON.stringify(userProgress));
      }

      // Step 5: Execute all Redis operations atomically
      try {
        await redisPipeline.exec();
      } catch (error) {
        console.error('Error executing Redis transaction:', error);
        return callback?.({ success: false, error: 'Failed to initialize round state' });
      }

      // Step 5.5: Update database status to IN_PROGRESS
      try {
        await prisma.round.update({
          where: { roundNumber: 0 },
          data: { status: 'IN_PROGRESS' }
        });
        console.log('Round 0 database status updated to IN_PROGRESS');
      } catch (error) {
        console.error('Error updating Round 0 database status:', error);
        // This is critical - we should rollback Redis operations
        try {
          const rollbackPipeline = redis.pipeline();
          rollbackPipeline.del(keys.problems);
          rollbackPipeline.del(keys.timer);
          participantsToUpdate.forEach(({ participantId }) => {
            const userKeys = getRedisKeys(participantId);
            rollbackPipeline.del(userKeys.state);
            rollbackPipeline.del(userKeys.progress);
            // Reset participant status
            const participantData = globalRoundState.participants.get(participantId);
            if (participantData) {
              participantData.status = 'WAITING';
              rollbackPipeline.hset(keys.lobby, participantId, JSON.stringify(participantData));
            }
          });
          await rollbackPipeline.exec();
          console.log('Rolled back Redis operations due to database error');
        } catch (rollbackError) {
          console.error('Failed to rollback Redis operations:', rollbackError);
        }
        return callback?.({ success: false, error: 'Failed to update database status' });
      }

      // Step 6: Update global state only after Redis success
      globalRoundState.problems = problems;
      globalRoundState.isActive = true;
      globalRoundState.startTime = startTime;
      
      // Update participants in global state
      participantsToUpdate.forEach(({ participantId, participantData }) => {
        globalRoundState.participants.set(participantId, participantData);
      });

      // Step 7: Start global timer
      startGlobalTimer(io);

      // Step 8: Emit round start to all participants
      io.to('round0').emit('round0:start', {
        problems,
        duration: ROUND_DURATION,
        startTime: startTime,
        message: 'Round 0 has started! Good luck!'
      });

      console.log(`Round 0 started by admin ${userId} with ${problems.length} problems`);
      
      callback?.({ 
        success: true, 
        message: `Round 0 started with ${problems.length} problems`,
        problems,
        duration: ROUND_DURATION
      });

    } catch (error) {
      console.error('Error in round0:ready:', error);
      
      // Rollback: Reset global state if it was modified
      if (globalRoundState.isActive) {
        globalRoundState.isActive = false;
        globalRoundState.startTime = null;
        globalRoundState.problems = [];
        globalRoundState.participants.clear();
        
        // Clear timer if it was started
        if (globalRoundState.timerInterval) {
          clearInterval(globalRoundState.timerInterval);
          globalRoundState.timerInterval = null;
        }
      }
      
      // Rollback: Reset participant status in Redis if they were updated
      if (participantsToUpdate.length > 0) {
        try {
          const rollbackPipeline = redis.pipeline();
          const keys = getRedisKeys();
          
          participantsToUpdate.forEach(({ participantId, participantData }) => {
            // Reset status back to WAITING
            participantData.status = 'WAITING';
            rollbackPipeline.hset(keys.lobby, participantId, JSON.stringify(participantData));
            
            // Remove user state and progress
            const userKeys = getRedisKeys(participantId);
            rollbackPipeline.del(userKeys.state);
            rollbackPipeline.del(userKeys.progress);
          });
          
          // Remove problems and timer
          rollbackPipeline.del(keys.problems);
          rollbackPipeline.del(keys.timer);
          
          await rollbackPipeline.exec();
          console.log('Successfully rolled back Redis state after error');
        } catch (rollbackError) {
          console.error('Error during rollback:', rollbackError);
        }
      }
      
      callback?.({ success: false, error: 'Failed to start Round 0' });
    }
  };

  // Handle round0:nextQuestion
  const handleNextQuestion = async (payload, callback) => {
    let userState = null;
    let userProgress = null;
    let redisOperationsExecuted = false;
    
    try {
      const { userId, error } = validateUser();
      
      if (error) {
        return callback?.({ success: false, error });
      }

      if (!globalRoundState.isActive) {
        return callback?.({ success: false, error: 'Round 0 is not active' });
      }

      const keys = getRedisKeys(userId);
      
      // Step 1: Get and validate user's current state
      let userStateRaw;
      try {
        userStateRaw = await redis.get(keys.state);
      } catch (error) {
        console.error('Error fetching user state:', error);
        return callback?.({ success: false, error: 'Failed to fetch user state' });
      }
      
      if (!userStateRaw) {
        return callback?.({ success: false, error: 'User state not found' });
      }

      userState = JSON.parse(userStateRaw);
      const currentIndex = userState.currentProblemIndex;
      const problems = userState.problems;

      // Step 2: Validate if there's a next problem
      if (currentIndex >= problems.length - 1) {
        return callback?.({ success: false, error: 'No more problems available' });
      }

      // Step 3: Get user progress
      let userProgressRaw;
      try {
        userProgressRaw = await redis.get(keys.progress);
      } catch (error) {
        console.error('Error fetching user progress:', error);
        return callback?.({ success: false, error: 'Failed to fetch user progress' });
      }

      // Step 4: Prepare updated state
      const originalIndex = userState.currentProblemIndex;
      userState.currentProblemIndex = currentIndex + 1;
      const nextProblem = problems[userState.currentProblemIndex];

      if (userProgressRaw) {
        userProgress = JSON.parse(userProgressRaw);
        userProgress.currentProblem = userState.currentProblemIndex;
        userProgress.lastActivity = new Date().toISOString();
      }

      // Step 5: Execute Redis operations atomically
      const redisPipeline = redis.pipeline();
      redisPipeline.setex(keys.state, 3600, JSON.stringify(userState));
      if (userProgress) {
        redisPipeline.setex(keys.progress, 3600, JSON.stringify(userProgress));
      }
      
      try {
        await redisPipeline.exec();
        redisOperationsExecuted = true;
      } catch (error) {
        console.error('Error executing Redis operations for nextQuestion:', error);
        return callback?.({ success: false, error: 'Failed to move to next question' });
      }

      // Step 6: Calculate remaining time
      const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
      const timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);

      console.log(`User ${userId} moved to problem ${userState.currentProblemIndex + 1}`);

      callback?.({ 
        success: true, 
        problem: nextProblem,
        problemIndex: userState.currentProblemIndex,
        totalProblems: problems.length,
        timeRemaining
      });

    } catch (error) {
      console.error('Error in round0:nextQuestion:', error);
      
      // Rollback: Reset user state if Redis operations were executed
      if (redisOperationsExecuted && userState) {
        try {
          const keys = getRedisKeys(socket.user?.email);
          
          // Rollback user state
          const rollbackUserState = { ...userState };
          rollbackUserState.currentProblemIndex = userState.currentProblemIndex - 1; // Revert to previous index
          
          const rollbackPipeline = redis.pipeline();
          rollbackPipeline.setex(keys.state, 3600, JSON.stringify(rollbackUserState));
          
          // Rollback progress if it was updated
          if (userProgress) {
            const rollbackProgress = { ...userProgress };
            rollbackProgress.currentProblem = rollbackUserState.currentProblemIndex;
            rollbackPipeline.setex(keys.progress, 3600, JSON.stringify(rollbackProgress));
          }
          
          await rollbackPipeline.exec();
          console.log('Successfully rolled back user state after nextQuestion error');
        } catch (rollbackError) {
          console.error('Error during nextQuestion rollback:', rollbackError);
        }
      }
      
      callback?.({ success: false, error: 'Failed to get next question' });
    }
  };

  // Handle disconnect
  const handleDisconnect = async () => {
    try {
      const userId = socket.user?.email;
      if (!userId) return;

      const keys = getRedisKeys(userId);
      
      // Update participant status in lobby
      const participantRaw = await redis.hget(keys.lobby, userId);
      if (participantRaw) {
        const participant = JSON.parse(participantRaw);
        participant.status = 'DISCONNECTED';
        participant.disconnectedAt = new Date().toISOString();
        
        await redis.hset(keys.lobby, userId, JSON.stringify(participant));
        
        // Update global state
        if (globalRoundState.participants.has(userId)) {
          globalRoundState.participants.set(userId, participant);
        }

        // Broadcast updated lobby state
        await broadcastLobbyUpdate(io);
      }

      // Remove user presence
      await redis.del(`round${ROUND_NUMBER}:user:${userId}`);
      
      console.log(`User ${userId} disconnected from Round 0`);

    } catch (error) {
      console.error('Error in Round 0 disconnect handler:', error);
    }
  };

  // SERVER → CLIENT EVENTS

  // Handle reconnection - Emit round0:reconnect
  const handleReconnection = async (userId) => {
    try {
      // Join socket rooms
      socket.join('round0');
      socket.join(`user:${userId}`);

      if (!globalRoundState.isActive) {
        socket.emit('round0:reconnect', {
          success: false,
          message: 'Round 0 is not currently active'
        });
        return;
      }

      const keys = getRedisKeys(userId);
      
      // Get user's game state
      const userStateRaw = await redis.get(keys.state);
      if (!userStateRaw) {
        socket.emit('round0:reconnect', {
          success: false,
          message: 'No active game state found'
        });
        return;
      }

      const userState = JSON.parse(userStateRaw);
      
      // Get user's progress
      const userProgressRaw = await redis.get(keys.progress);
      const userProgress = userProgressRaw ? JSON.parse(userProgressRaw) : {};

      // Calculate remaining time
      const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
      const timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);

      // Update participant status to reconnected
      const participantRaw = await redis.hget(keys.lobby, userId);
      if (participantRaw) {
        const participant = JSON.parse(participantRaw);
        participant.status = 'IN_MATCH';
        participant.reconnectedAt = new Date().toISOString();
        await redis.hset(keys.lobby, userId, JSON.stringify(participant));
      }

      // Join socket room
      socket.join('round0');

      // Send reconnection data
      socket.emit('round0:reconnect', {
        success: true,
        currentProblem: userState.problems[userState.currentProblemIndex],
        problemIndex: userState.currentProblemIndex,
        totalProblems: userState.problems.length,
        timeRemaining,
        progress: userProgress,
        message: 'Successfully reconnected to Round 0'
      });

      console.log(`User ${userId} reconnected to Round 0`);

    } catch (error) {
      console.error('Error in handleReconnection:', error);
      socket.emit('round0:reconnect', {
        success: false,
        message: 'Failed to reconnect to Round 0'
      });
    }
  };

  const handleGetState = async (payload) => {
    try {
      const validation = validateUser();
      if (validation.error) {
        socket.emit('round0:state', { success: false, error: validation.error });
        return;
      }
      const { userId } = validation;

      // Join socket rooms
      socket.join('round0');
      socket.join(`user:${userId}`);

      // Check database status first
      const round0DB = await prisma.round.findUnique({
        where: { roundNumber: 0 }
      });

      if (!round0DB) {
        socket.emit('round0:state', { success: false, error: 'Round 0 not found in database' });
        return;
      }

      if (round0DB.status !== 'IN_PROGRESS') {
        socket.emit('round0:state', { 
          success: false, 
          error: `Round 0 is not active. Database status: ${round0DB.status}` 
        });
        return;
      }

      // Sync in-memory state with database
      if (!globalRoundState.isActive && round0DB.status === 'IN_PROGRESS') {
        console.log('Database shows IN_PROGRESS but in-memory state shows inactive. Syncing...');
        await syncGlobalStateWithRedis();
      }

      if (!globalRoundState.isActive) {
        socket.emit('round0:state', { success: false, error: 'Round 0 is not active' });
        return;
      }

      const keys = getRedisKeys(userId);
      const userStateRaw = await redis.get(keys.state);
      
      if (!userStateRaw) {
        socket.emit('round0:state', { success: false, error: 'User state not found' });
        return;
      }

      const userState = JSON.parse(userStateRaw);
      const userProgressRaw = await redis.get(keys.progress);
      const userProgress = userProgressRaw ? JSON.parse(userProgressRaw) : {};

      const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
      const timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);

      socket.join('round0');

      socket.emit('round0:state', {
        success: true,
        currentProblem: userState.problems[userState.currentProblemIndex],
        problemIndex: userState.currentProblemIndex,
        problems: userState.problems,
        totalProblems: userState.problems.length,
        isActive: globalRoundState.isActive,
        timeRemaining,
        progress: userProgress,
        message: 'Current state retrieved successfully'
      });

    } catch (error) {
      console.error('Error in round0:getState:', error);
      socket.emit('round0:state', { success: false, error: 'Failed to get current state' });
    }
  };

  // Handle round0:reset (Admin only)
  // const handleReset = async (payload, callback) => {
  //   const validation = validateUser();
  //   if (validation.error) {
  //     return callback?.({ success: false, error: validation.error });
  //   }
  //   const { email } = validation;

  //   try {
  //     // Check if user is admin
  //     const userData = await prisma.user.findUnique({
  //       where: { id: email },
  //       select: { role: true }
  //     });

  //     if (!userData || userData.role !== 'ADMIN') {
  //       return callback?.({ success: false, error: 'Only admins can reset Round 0' });
  //     }

  //     const success = await resetRoundState();
      
  //     if (success) {
  //       // Update database status back to LOBBY
  //       await prisma.round.update({
  //         where: { roundNumber: 0 },
  //         data: { status: 'LOBBY' }
  //       });
        
  //       // Notify all clients about the reset
  //       io.emit('round0:reset', { message: 'Round 0 has been reset by admin' });
        
  //       console.log(`Round 0 reset by admin`);
  //     }

  //     callback?.({ 
  //       success, 
  //       message: success ? 'Round 0 reset successfully' : 'Failed to reset Round 0'
  //     });

  //   } catch (error) {
  //     console.error('Error in round0:reset:', error);
  //     callback?.({ success: false, error: 'Failed to reset Round 0' });
  //   }
  // };

  // EVENT LISTENERS
  socket.on('round0:join', handleJoinLobby);
  socket.on('round0:ready', handleAdminReady); 
  socket.on('round0:nextQuestion', handleNextQuestion);
  socket.on('round0:getState', handleGetState);
  // socket.on('round0:reset', handleReset);
  socket.on('disconnect', handleDisconnect);

  // INITIALIZATION
  Promise.all([
    syncGlobalStateWithRedis(),
    (() => {
      const userId = socket.user?.email;
      if (userId && globalRoundState.isActive) {
        return handleReconnection(userId);
      }
      return Promise.resolve();
    })()
  ]).catch(error => {
    console.error('Error during socket initialization:', error);
  });
};

// Admin functions
export const round0AdminAddUser = async (io, userId) => {
  try {
    if (!userId) {
      io.emit("admin:error", { error: "Invalid user email" });
      return;
    }

    const keys = getRedisKeys(userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, eventScore: true, role: true }
    });

    if (!user) {
      io.emit("admin:error", { error: "User not found" });
      return;
    }

    const roundDB = await prisma.round.findUnique({
      where: { roundNumber: ROUND_NUMBER }
    });

    if (!roundDB) {
      io.emit("admin:error", { error: `Round ${ROUND_NUMBER} not found` });
      return;
    }

    if (roundDB.status === "COMPLETED") {
      io.emit("admin:error", { error: "Round already ended" });
      return;
    }

    const existing = await redis.hget(keys.lobby, userId);
    if (existing) {
      io.to(`user:${userId}`).emit(`round${ROUND_NUMBER}:adminAdded`);
      return;
    }

    const participant = {
      userId,
      username: user.username,
      email: userId,
      role: user.role || 'USER',
      status: roundDB.status === 'IN_PROGRESS' ? 'IN_MATCH' : 'WAITING',
      joinedAt: new Date().toISOString(),
      isReady: false
    };

    await redis.hset(keys.lobby, userId, JSON.stringify(participant));
    await broadcastLobbyUpdate(io);

    io.to(`user:${userId}`).emit(`round${ROUND_NUMBER}:adminAdded`);
    io.emit("admin:success", { action: "add", userId, round: ROUND_NUMBER });

  } catch (err) {
    console.error(`[Admin Add User R${ROUND_NUMBER}]`, err);
    io.emit("admin:error", { error: "Failed to add user" });
  }
};

export const round0AdminRemoveUser = async (io, userId) => {
  try {
    const keys = getRedisKeys(userId);
    const participantStr = await redis.hget(keys.lobby, userId);
    
    if (!participantStr) {
      io.emit("admin:error", { error: "User not in round" });
      return;
    }

    await redis.del(keys.state);
    await redis.del(keys.progress);
    await redis.hdel(keys.lobby, userId);

    await broadcastLobbyUpdate(io);

    io.to(`user:${userId}`).emit(`round${ROUND_NUMBER}:adminRemoved`);
    io.emit("admin:success", { action: "remove", userId, round: ROUND_NUMBER });

  } catch (err) {
    console.error(`[Admin Remove User R${ROUND_NUMBER}]`, err);
    io.emit("admin:error", { error: "Failed to remove user" });
  }
};

// Export helper function to check round status
export const getRound0Status = async () => {
  try {
    const keys = { lobby: `round${ROUND_NUMBER}:lobby` };
    const allParticipantsRaw = await redis.hgetall(keys.lobby);
    const participants = Object.entries(allParticipantsRaw).map(([uid, value]) => ({
      userId: uid,
      ...JSON.parse(value)
    }));

    let timeRemaining = 0;
    if (globalRoundState.isActive && globalRoundState.startTime) {
      const elapsed = Math.floor((Date.now() - globalRoundState.startTime) / 1000);
      timeRemaining = Math.max(ROUND_DURATION - elapsed, 0);
    }

    return {
      isActive: globalRoundState.isActive,
      participants,
      totalParticipants: participants.length,
      timeRemaining,
      duration: ROUND_DURATION
    };
  } catch (error) {
    console.error('Error getting Round 0 status:', error);
    return {
      isActive: false,
      participants: [],
      totalParticipants: 0,
      timeRemaining: 0,
      duration: ROUND_DURATION
    };
  }
};


