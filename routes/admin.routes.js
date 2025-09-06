import express from "express";
import prisma from "../config/prisma.js";
import verifyAuthToken from "../middleware/authMiddleware.js";

const router = express.Router();

// Middleware to check admin role
const requireAdmin = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { email: req.user.email },
      select: { role: true }
    });

    if (!user || user.role !== 'ADMIN') {
      return res.status(403).json({ 
        success: false, 
        error: 'Admin access required' 
      });
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to verify admin status' 
    });
  }
};

// Get all rounds status
router.get('/rounds', verifyAuthToken, requireAdmin, async (req, res) => {
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

    res.json({
      success: true,
      rounds: rounds.map(round => ({
        roundNumber: round.roundNumber,
        status: round.status,
        isLocked: round.status === 'LOCKED',
        isActive: round.status === 'IN_PROGRESS',
        problemCount: round._count.problems,
        submissionCount: round._count.submissions
      }))
    });
  } catch (error) {
    console.error('Error fetching rounds:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch rounds' 
    });
  }
});

// Update round status
router.patch('/rounds/:roundNumber/status', verifyAuthToken, requireAdmin, async (req, res) => {
  try {
    const { roundNumber } = req.params;
    const { status } = req.body;

    // Validate round number
    const roundNum = parseInt(roundNumber);
    if (isNaN(roundNum) || roundNum < 0 || roundNum > 3) {
      return res.status(400).json({
        success: false,
        error: 'Invalid round number. Must be 0-3.'
      });
    }

    // Validate status
    const validStatuses = ['LOCKED', 'LOBBY', 'IN_PROGRESS', 'COMPLETED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Get current round
    const currentRound = await prisma.round.findUnique({
      where: { roundNumber: roundNum }
    });

    if (!currentRound) {
      return res.status(404).json({
        success: false,
        error: 'Round not found'
      });
    }

    // Validate status transitions
    const currentStatus = currentRound.status;
    const validTransitions = {
      'LOCKED': ['LOBBY'],
      'LOBBY': ['IN_PROGRESS', 'LOCKED'],
      'IN_PROGRESS': ['COMPLETED', 'LOBBY'],
      'COMPLETED': ['LOBBY'] // Allow reopening if needed
    };

    if (!validTransitions[currentStatus]?.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid transition from ${currentStatus} to ${status}`
      });
    }

    // Update round status
    const updatedRound = await prisma.round.update({
      where: { roundNumber: roundNum },
      data: { status }
    });

    // Get updated rounds list for broadcast
    const allRounds = await prisma.round.findMany({
      orderBy: { roundNumber: 'asc' },
      select: {
        roundNumber: true,
        status: true
      }
    });

    // Broadcast the update to all connected clients via socket if available
    if (req.app.get('io')) {
      const io = req.app.get('io');
      const roundsData = {
        currentRoundNumber: allRounds.find(r => r.status === 'IN_PROGRESS')?.roundNumber || 0,
        currentRoundStatus: allRounds.find(r => r.status === 'IN_PROGRESS')?.status || 'LOCKED',
        rounds: allRounds.map(round => ({
          roundNumber: round.roundNumber,
          status: round.status,
          isActive: round.status === 'IN_PROGRESS',
          isLocked: round.status === 'LOCKED'
        }))
      };
      
      io.emit('server:currentRound', roundsData);
      console.log(`Broadcasted round update: Round ${roundNum} → ${status}`);
    }

    res.json({
      success: true,
      message: `Round ${roundNum} status updated to ${status}`,
      round: {
        roundNumber: updatedRound.roundNumber,
        status: updatedRound.status,
        isLocked: updatedRound.status === 'LOCKED',
        isActive: updatedRound.status === 'IN_PROGRESS'
      }
    });

    console.log(`Admin updated Round ${roundNum}: ${currentStatus} → ${status}`);

  } catch (error) {
    console.error('Error updating round status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update round status' 
    });
  }
});

// Reset all rounds to LOCKED (emergency function)
router.post('/rounds/reset', verifyAuthToken, requireAdmin, async (req, res) => {
  try {
    await prisma.round.updateMany({
      data: { status: 'LOCKED' }
    });

    // Broadcast the update
    if (req.app.get('io')) {
      const io = req.app.get('io');
      const roundsData = {
        currentRoundNumber: 0,
        currentRoundStatus: 'LOCKED',
        rounds: [0, 1, 2, 3].map(roundNumber => ({
          roundNumber,
          status: 'LOCKED',
          isActive: false,
          isLocked: true
        }))
      };
      
      io.emit('server:currentRound', roundsData);
      console.log('Broadcasted round reset - all rounds locked');
    }

    res.json({
      success: true,
      message: 'All rounds reset to LOCKED status'
    });

    console.log('Admin reset all rounds to LOCKED');

  } catch (error) {
    console.error('Error resetting rounds:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to reset rounds' 
    });
  }
});

export default router;

