import redis from "../config/redis.js";
import prisma from "../config/prisma.js";




export async function runMatchmaking() {
  try {
    //need to extract users from the ready1:queue sorted by the rank
    /* note: zrange is used to get the range of elements in a sorted set
    and WITHSCORES option is used to get the scores along with the elements. */
    const players = await redis.zrange("round1:readyQueue", 0, -1, "WITHSCORES");
    console.log("Players in queue:", players);

    if ( players.length === 0 ) return; 

    const playerList = []; 
    for ( let i =0; i< players.length; i+=2) {
      playerList.push({ userId: players[i], rank: parseInt(players[i + 1]) });
    }

    const size = playerList.length;
    const third = Math.ceil(size / 3);
    // the g1, g2, g3 logic - three levels; such that G3 > G2 > G1
    let G1 = playerList.slice(0, third);
    let G2 = playerList.slice(third, 2 * third);
    let G3 = playerList.slice(2 * third, size);

    if (G1.length % 2 !== 0 && G2.length % 2 !== 0) {
      G2.push(G1.pop());
    }
    if (G2.length % 2 !== 0 && G3.length % 2 !== 0) {
      G3.push(G2.pop());
    }

    // 4. Match players inside each group
    await matchGroup(G1, "HARD", 25 * 60);
    await matchGroup(G2, "MEDIUM", 20 * 60);
    await matchGroup(G3, "EASY", 15 * 60);
  }
  catch (error) {
    console.error("Error in matchmaking:", error);
  }
}

async function matchGroup(group, difficulty, timerSeconds) {
  for (let i = 0; i < group.length - 1; i += 2) {
    const p1 = group[i];
    const p2 = group[i + 1];

    // 1. Create match in DB
    const problem = await prisma.problem.findFirst({
      where: { difficulty },
      orderBy: { createdAt: "desc" }, // pick latest (or randomize later)
    });

    if (!problem) {
      console.error(`No problem found for difficulty: ${difficulty}`);
      continue;
    }

    const match = await prisma.match.create({
      data: {
        playerAId: p1.userId,
        playerBId: p2.userId,
        problemId: problem.id,
        status: "ONGOING",
      },
    });

    // 2. Remove from readyQueue using multi for atomicity
    const multi = redis.multi();
    multi.zrem("round1:readyQueue", p1.userId, p2.userId);
    // Optionally track matched players
    multi.sadd("round1:matched", p1.userId, p2.userId);
    await multi.exec();

    // 3. Emit event to both players
    io.to(p1.userId).emit("round1:matchFound", {
      matchId: match.id,
      opponent: p2.userId,
      problem,
      timer: timerSeconds,
    });
    io.to(p2.userId).emit("round1:matchFound", {
      matchId: match.id,
      opponent: p1.userId,
      problem,
      timer: timerSeconds,
    });
  }

  // If 1 leftover → assign Team Bot
  if (group.length % 2 === 1) {
    const lonePlayer = group[group.length - 1];
    console.log(`Assigning ${lonePlayer.userId} to Team Bot`);

    // Remove from readyQueue using multi
    const multi = redis.multi();
    multi.zrem("round1:readyQueue", lonePlayer.userId);
    multi.sadd("round1:lone", lonePlayer.userId);
    await multi.exec();

    // Can create a dummy match vs BOT here
  }
}



export const round1Handler = (io, socket) => {
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
  
    socket.on("client:sendMessage", handleClientMessage);
  };
  
