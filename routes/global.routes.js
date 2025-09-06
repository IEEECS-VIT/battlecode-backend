import { Router } from "express";
import prisma from "../config/prisma.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error fetching user data" });
  }
});

// Get current round status and all rounds
router.get("/rounds", async (req, res) => {
  try {
    const rounds = await prisma.round.findMany({
      orderBy: { roundNumber: 'asc' },
      select: {
        roundNumber: true,
        status: true,
        _count: {
          select: {
            problems: true,
            submissions: true
          }
        }
      }
    });

    // Find current active round
    const currentRound = rounds.find(r => r.status === 'IN_PROGRESS');
    const currentRoundNumber = currentRound?.roundNumber || 0;
    const currentRoundStatus = currentRound?.status || 'LOCKED';

    const roundsData = {
      currentRoundNumber,
      currentRoundStatus,
      rounds: rounds.map(round => ({
        roundNumber: round.roundNumber,
        status: round.status,
        isActive: round.status === 'IN_PROGRESS',
        isLocked: round.status === 'LOCKED',
        problemCount: round._count.problems,
        submissionCount: round._count.submissions
      }))
    };

    res.json({
      success: true,
      data: roundsData
    });
  } catch (error) {
    console.error('Error fetching rounds:', error);
    res.status(500).json({ 
      success: false, 
      error: "Error fetching round data" 
    });
  }
});

export default router;