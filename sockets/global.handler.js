import prisma from "../config/prisma.js";
import { round1RecoveryHandler,endRound1 } from "./round1.handler.js";

export const globalHandler = (io, socket) => {
  console.log(` Global handler initialized for user: ${socket.user.email}`);

  socket.on("admin:endRound", async ({ roundNumber }) => {
  if (socket.user.role !== "ADMIN") {
    socket.emit("admin:error", { error: "Unauthorized" });
    return;
  }

  if (roundNumber === 1) {
    await endRound1(io);

  const updatedRound = await getCurrentRound();
  io.emit("server:currentRound", updatedRound);
  }
});
  
  // Handle user joining - ensure they're in the leaderboard
  const handleUserJoin = async (payload, callback) => {
    console.log(`handleUserJoin called for user: ${socket.user.email}`);
    try {
      const userId = socket.user.email;
      
      // Check if user exists and update their last activity
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          username: true,
          eventScore: true,
          currentRound: true,
          role: true
        }
      });

      if (!user) {
        if (callback) {
          callback({ success: false, error: "User not found" });
        }
        return;
      }

      await broadcastLeaderboard(io);
    
      const currentRound = await getCurrentRound();
      console.log(` Sending current round data to user:`, currentRound);
      socket.emit("server:currentRound", currentRound);

      console.log(`User ${user.username || user.name} joined the global socket`);
      
      if (callback) {
        callback({ 
          success: true, 
          user: {
            id: user.id,
            name: user.name,
            username: user.username,
            eventScore: user.eventScore,
            currentRound: user.currentRound
          }
        });
      }
    } catch (error) {
      console.error("Error handling user join:", error);
      if (callback) {
        callback({ success: false, error: "Internal server error" });
      }
    }
  };

  const bootstrapSocket = async () => {
  const currentRound = await getCurrentRound();

  if (
    currentRound.currentRoundNumber === 1 &&
    currentRound.currentRoundStatus === 'IN_PROGRESS'
  ) {
    await round1RecoveryHandler(io, socket, socket.user.email);
  }

  // ONLY after recovery finishes
  await handleUserJoin({}, null);
};

bootstrapSocket();

  // Handle leaderboard request
  const handleLeaderboardRequest = async (payload, callback) => {
    console.log(`handleLeaderboardRequest called for user: ${socket.user.email}`);
    try {
      const { currentRoundNumber, currentRoundStatus } = await getCurrentRound();

    if (
      currentRoundNumber === 3 &&
      currentRoundStatus !== 'LOCKED'
    ) {
      return callback?.({
        success: false,
        error: "Leaderboard is locked"
      });
    }

    if (currentRoundNumber > 3) {
      return callback?.({
        success: false,
        error: "Leaderboard is no longer available"
      });
    }
      const leaderboard = await getLeaderboard();
      
      console.log(`Sending leaderboard data:`, leaderboard);
      socket.emit("server:leaderboard", { leaderboard });
      
      if (callback) {
        callback({ success: true, leaderboard });
      }
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      if (callback) {
        callback({ success: false, error: "Failed to fetch leaderboard" });
      }
    }
  };

  // Handle current round request
  const handleCurrentRoundRequest = async (payload, callback) => {
    console.log(`handleCurrentRoundRequest called for user: ${socket.user.email}`);
    try {
      const currentRound = await getCurrentRound();
      
      console.log(`Sending current round data:`, currentRound);
      socket.emit("server:currentRound", currentRound);
      
      if (callback) {
        callback({ success: true, currentRound });
      }
    } catch (error) {
      console.error("Error fetching current round:", error);
      if (callback) {
        callback({ success: false, error: "Failed to fetch current round" });
      }
    }
  };

  const handleClientMessage = (payload, callback) => {
    console.log(
      `Message from client ${socket.id} (User: ${socket.user.email}): "${payload.message}"`
    );

    socket.emit("server:messageReceived", {
      confirmation: `We received your message: "${payload.message}"`,
    });

    if (callback) {
      callback({ success: true, status: "Message handled by server." });
    }
  };

  // Handle user broadcast - placeholder function
  const handleUserBroadcast = (payload, callback) => {
    console.log(`handleUserBroadcast received from user: ${socket.user.email}`, payload);
    // This can be expanded based on what broadcast functionality is needed
    if (callback) {
      callback({ success: true, status: "Broadcast message received" });
    }
  };

  // Socket event listeners
  console.log(` Setting up socket event listeners for user: ${socket.user.email}`);
  socket.on("user:join", handleUserJoin);
  socket.on("user:leaderboard", handleLeaderboardRequest);
  socket.on("user:current-round", handleCurrentRoundRequest);
  socket.on("user:broadcast", handleUserBroadcast);
};

// Helper function to get current round
const getCurrentRound = async () => {
  try {
    // Get all rounds with their status
    const rounds = await prisma.round.findMany({
      orderBy: { roundNumber: 'asc' },
      select: {
        roundNumber: true,
        status: true
      }
    });

    // Find the current active round (IN_PROGRESS) or the next upcoming round (LOBBY)
    let currentRound = rounds.find(r => r.status === 'IN_PROGRESS');
    
    if (!currentRound) {
      // If no round is in progress, find the next round in lobby state
      currentRound = rounds.find(r => r.status === 'LOBBY');
    }
    
    if (!currentRound) {
    
      currentRound = rounds.find(r => r.status === 'LOCKED');
    }

    const roundStatuses = rounds.map(round => ({
      roundNumber: round.roundNumber,
      status: round.status,
      isActive: round.status === 'IN_PROGRESS',
      isLocked: round.status === 'LOCKED'
    }));

    return {
      currentRoundNumber: currentRound?.roundNumber || 0,
      currentRoundStatus: currentRound?.status || 'LOCKED',
      rounds: roundStatuses
    };
  } catch (error) {
    console.error("Error getting current round:", error);
    return {
      currentRoundNumber: 0,
      currentRoundStatus: 'LOCKED',
      rounds: []
    };
  }
};


const getLeaderboard = async () => {
  let retries = 3;
  while (retries > 0) {
    try {
      const users = await prisma.user.findMany({
        where: {
          role: { in: ['PLAYER', 'ADMIN'] }
        },
        select: {
          id: true,
          name: true,
          username: true,
          eventScore: true,
          currentRound: true,
          regNo: true
        },
        orderBy: [
          { eventScore: 'desc' },
          { name: 'asc' } 
        ]
      });

      const leaderboard = users.map((user, index) => ({
        rank: index + 1,
        id: user.id,
        name: user.name,
        username: user.username || 'Not Set',
        score: user.eventScore,
        currentRound: user.currentRound,
        regNo: user.regNo,
        trend: '' 
      }));

      return leaderboard;
    } catch (error) {
      console.error(`Error getting leaderboard (retries left: ${retries - 1}):`, error.message);
      retries--;
      if (retries === 0) {
        console.error("Failed to get leaderboard after 3 retries");
        return [];
      }
      // Wait 2 seconds before retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries)));
    }
  }
};

socket.on("global:violation", handleGlobalViolation);

const handleGlobalViolation = async (payload, callback) => {

  const currentRound = await prisma.round.findFirst({
    where: {
      status: 'IN_PROGRESS',
    },
  });
  console.log(`handling violation for round ${currentRound}`);
  console.log(`user:  ${payload?.userId} has violated 5 times`);

  if (!currentRound) {
    if (callback) {
      callback({ success: false, error: "No round in progress" });
    }
    return;
  }
  else if (curentRound === 0) {
    await handleRound0Violation(payload, callback);
  }
  else if (currentRound.roundNumber === 1) {
    await handleRound1Violation(payload, callback);
  }
  else if (currentRound.roundNumber === 2) {
    await handleRound2Violation(payload, callback);
  }
  else if (currentRound.roundNumber === 3) {
    await handleRound3Violation(payload, callback);
  }
  else {
    if (callback) {
      callback({ success: false, error: "No round in progress" });
    }
    return;
  }
}

const broadcastLeaderboard = async (io) => {
  try {
    const {
      currentRoundNumber,
      currentRoundStatus
    } = await getCurrentRound();

    if (currentRoundNumber === 3 && currentRoundStatus !== 'LOCKED') {
      return;
    }

    if (currentRoundNumber > 3) {
      return;
    }
    const leaderboard = await getLeaderboard();
    if (leaderboard.length > 0) {
      io.emit("server:leaderboard", { leaderboard });
      console.log(`Broadcasted leaderboard to ${io.engine.clientsCount} clients`);
    }
  } catch (error) {
    console.error("Error broadcasting leaderboard:", error);
  }
};

export { getCurrentRound, getLeaderboard, broadcastLeaderboard };
  