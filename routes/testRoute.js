import express from 'express';
import prisma from '../battlecode-backend/config/prisma.js';
import verifyAuthToken from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/insert-test', verifyAuthToken, async (req, res) => {
  try {
    // Insert a test user
    const testUser = await prisma.user.create({
      data: {
        username: 'testuser',
        email: 'testuser@example.com',
        role: 'PLAYER',
        badges: ['Beginner'],
      },
    });

    // Insert stats for the test user
    const testStats = await prisma.stats.create({
      data: {
        userId: testUser.id,
        eloRating: 1200,
        gamesPlayed: 10,
        totalTimeSpent: 3600, // in seconds
      },
    });

    // Insert a test problem
    const testProblem = await prisma.problem.create({
      data: {
        title: 'Sample Problem',
        description: 'Solve this sample problem.',
        sampleCases: ['Input: 1, Output: 2'],
        hiddenTestCases: ['Input: 2, Output: 4'],
        category: ['Math', 'Logic'],
        constraints: ['1 <= n <= 100'],
        avgTimeComplexity: 'O(n)',
        avgSpaceComplexity: 'O(1)',
        difficulty: 'Easy',
      },
    });

    // Insert a test match
    const testMatch = await prisma.match.create({
      data: {
        playerAId: testUser.id,
        playerBId: testUser.id, // For testing, using the same user as both players
        winnerId: testUser.id,
        duration: 300, // in seconds
        problems: {
          connect: [{ id: testProblem.id }],
        },
      },
    });

    // Insert a test submission
    const testSubmission = await prisma.submission.create({
      data: {
        matchId: testMatch.id,
        problemId: testProblem.id,
        playerId: testUser.id,
        code: 'console.log("Hello, World!");',
        language: 'JavaScript',
        testCasesPassed: 1,
        totalTestCases: 1,
        isCheat: false,
      },
    });

    res.json({
      success: true,
      data: {
        user: testUser,
        stats: testStats,
        problem: testProblem,
        match: testMatch,
        submission: testSubmission,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Failed to insert test data' });
  }
});

export default router;