import express from "express";
import axios from "axios";
import http from 'http';
import prisma from "../config/prisma.js";
import { calculateScore } from "../utils/calculateScore.js";
import verifyAuthToken from "../middleware/authMiddleware.js";

const router = express.Router();

const JUDGE0_API_URL = process.env.JUDGE0_API_URL;
const JUDGE0_API_KEY = null;

const LANGUAGE_ID_MAP = {
  cpp: 54,
  python: 71,
  java: 62,
  c: 50,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /run
 * Test code against sample test cases only (no database changes)
 */
router.post("/run", async (req, res) => {
  try {
    const { language, source_code, problemId } = req.body;
    // const userId = req.user?.id;

    // if (!userId) {
    //   return res.status(401).json({ error: "Unauthorized" });
    // }

    if (!language || !source_code || !problemId) {
      return res.status(400).json({
        error: "Missing required fields: language, source_code, problemId",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    // Get problem and sample test cases
    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: { sampleTestCases: true, title: true }
    });

    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    const sampleTestCases = Array.isArray(problem.sampleTestCases) 
      ? problem.sampleTestCases 
      : problem.sampleTestCases.testCases || [];

    if (sampleTestCases.length === 0) {
      return res.status(400).json({ error: "No sample test cases found" });
    }

    const httpAgent = new http.Agent();
    const axiosConfig = {
      httpAgent,
      headers: JUDGE0_API_KEY ? { "X-RapidAPI-Key": JUDGE0_API_KEY } : {}
    };

    // Prepare submissions for sample test cases only
    const submissions = sampleTestCases.map((testCase) => ({
      language_id,
      source_code,
      stdin: testCase.stdin || testCase.input || "",
      expected_output: testCase.expected_output || testCase.output || "",
    }));

    // Submit batch to Judge0
    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions/batch`,
      { submissions },
      axiosConfig
    );

    const tokens = submissionResponse.data.map(item => item.token);
    const results = [];
    const startTime = Date.now();
    const timeout = 15000;

    // Poll for results
    while (results.length < tokens.length && Date.now() - startTime < timeout) {
      const pendingTokens = tokens.filter(
        token => !results.some(r => r.token === token)
      );

      const statusResponses = await Promise.all(
        pendingTokens.map(token => 
          axios.get(`${JUDGE0_API_URL}/submissions/${token}`, axiosConfig)
            .catch(err => ({ data: { token, error: err.message } }))
        )
      );

      for (const response of statusResponses) {
        const data = response.data;
        
        if (results.some(r => r.token === data.token)) continue;

        const statusId = data.status?.id;

        if (statusId === 1 || statusId === 2) {
          continue;
        } else {
          results.push({
            token: data.token,
            status: data.status,
            stdout: data.stdout,
            stderr: data.stderr,
            compile_output: data.compile_output,
            time: data.time,
            memory: data.memory,
            passed: data.status?.id === 3
          });
        }
      }

      if (results.length === tokens.length) break;
      await sleep(1000);
    }

    if (results.length < tokens.length) {
      return res.status(408).json({ error: "Execution timed out" });
    }

    // Calculate passed test cases
    const passedCount = results.filter(r => r.passed).length;
    const totalCount = sampleTestCases.length;

    res.status(200).json({
      success: true,
      results,
      summary: {
        passed: passedCount,
        total: totalCount,
        percentage: Math.round((passedCount / totalCount) * 100)
      }
    });

  } catch (error) {
    console.error("Run execution error:", error.message);
    res.status(500).json({
      error: "Failed to execute code",
      details: error.response?.data || error.message
    });
  }
});

/**
 * POST /submit
 * Submit code against all test cases with database updates and scoring
 */
router.post("/submit", verifyAuthToken, async (req, res) => {
  try {
    const { language, source_code, problemId, roundNumber } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!language || !source_code || !problemId || roundNumber === undefined) {
      return res.status(400).json({
        error: "Missing required fields: language, source_code, problemId, roundNumber",
      });
    }

    const language_id = LANGUAGE_ID_MAP[language.toLowerCase()];
    if (!language_id) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    // Get problem with both sample and hidden test cases
    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: { 
        sampleTestCases: true, 
        hiddenTestCases: true, 
        title: true,
        roundId: true
      }
    });

    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    if (problem.roundId !== roundNumber) {
      return res.status(400).json({ error: "Problem does not belong to specified round" });
    }

    const sampleTestCases = Array.isArray(problem.sampleTestCases) 
      ? problem.sampleTestCases 
      : problem.sampleTestCases.testCases || [];
      
    const hiddenTestCases = Array.isArray(problem.hiddenTestCases) 
      ? problem.hiddenTestCases 
      : problem.hiddenTestCases.testCases || [];

    const allTestCases = [...sampleTestCases, ...hiddenTestCases];

    if (allTestCases.length === 0) {
      return res.status(400).json({ error: "No test cases found" });
    }

    const httpAgent = new http.Agent();
    const axiosConfig = {
      httpAgent,
      headers: JUDGE0_API_KEY ? { "X-RapidAPI-Key": JUDGE0_API_KEY } : {}
    };

    // Prepare submissions for all test cases
    const submissions = allTestCases.map((testCase) => ({
      language_id,
      source_code,
      stdin: testCase.stdin || testCase.input || "",
      expected_output: testCase.expected_output || testCase.output || "",
    }));

    // Submit batch to Judge0
    const submissionResponse = await axios.post(
      `${JUDGE0_API_URL}/submissions/batch`,
      { submissions },
      axiosConfig
    );

    const tokens = submissionResponse.data.map(item => item.token);
    const results = [];
    const startTime = Date.now();
    const timeout = 20000; // Longer timeout for full submission

    // Poll for results
    while (results.length < tokens.length && Date.now() - startTime < timeout) {
      const pendingTokens = tokens.filter(
        token => !results.some(r => r.token === token)
      );

      const statusResponses = await Promise.all(
        pendingTokens.map(token => 
          axios.get(`${JUDGE0_API_URL}/submissions/${token}`, axiosConfig)
            .catch(err => ({ data: { token, error: err.message } }))
        )
      );

      for (const response of statusResponses) {
        const data = response.data;
        
        if (results.some(r => r.token === data.token)) continue;

        const statusId = data.status?.id;

        if (statusId === 1 || statusId === 2) {
          continue;
        } else {
          results.push({
            token: data.token,
            status: data.status,
            stdout: data.stdout,
            stderr: data.stderr,
            compile_output: data.compile_output,
            time: data.time,
            memory: data.memory,
            passed: data.status?.id === 3
          });
        }
      }

      if (results.length === tokens.length) break;
      await sleep(1000);
    }

    if (results.length < tokens.length) {
      return res.status(408).json({ error: "Submission execution timed out" });
    }

    // Calculate results
    const passedCount = results.filter(r => r.passed).length;
    const totalCount = allTestCases.length;
    const hasAnyPass = passedCount > 0;

    // Determine submission status
    let submissionStatus;
    if (results.some(r => r.compile_output)) {
      submissionStatus = 'COMPILATION_ERROR';
    } else if (results.some(r => r.stderr)) {
      submissionStatus = 'RUNTIME_ERROR';
    } else if (results.some(r => r.time > 2.0)) { // 2 second time limit
      submissionStatus = 'TIME_LIMIT_EXCEEDED';
    } else if (passedCount === totalCount) {
      submissionStatus = 'ACCEPTED';
    } else {
      submissionStatus = 'WRONG_ANSWER';
    }

    // Only create submission if at least one test case passes
    if (hasAnyPass) {
      // Calculate score (black box returns 5 for now)
      const currentScore = calculateScore() || 5;

      // Get user's current score
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { eventScore: true }
      });

      // Update score only if it has increased
      const newScore = Math.max(user.eventScore, currentScore);

      // Delete any existing submission for this user and problem (keep only latest)
      await prisma.submission.deleteMany({
        where: {
          userId: userId,
          problemId: problemId
        }
      });

      // Create new submission
      const submission = await prisma.submission.create({
        data: {
          userId: userId,
          problemId: problemId,
          roundId: roundNumber,
          code: source_code,
          language: language,
          status: submissionStatus,
          runtime: Math.max(...results.map(r => r.time || 0)),
          memory: Math.max(...results.map(r => r.memory || 0)),
          testCasesPassed: passedCount,
          executionCount: 1
        }
      });

      // Update user score if it increased
      if (newScore > user.eventScore) {
        await prisma.user.update({
          where: { id: userId },
          data: { eventScore: newScore }
        });
      }

      res.status(200).json({
        success: true,
        submission: {
          id: submission.id,
          status: submissionStatus,
          testCasesPassed: passedCount,
          totalTestCases: totalCount,
          score: currentScore,
          scoreUpdated: newScore > user.eventScore
        },
        results,
        summary: {
          passed: passedCount,
          total: totalCount,
          percentage: Math.round((passedCount / totalCount) * 100)
        }
      });

    } else {
      // No test cases passed, don't create submission
      res.status(200).json({
        success: false,
        message: "No test cases passed. Submission not saved.",
        results,
        summary: {
          passed: passedCount,
          total: totalCount,
          percentage: 0
        }
      });
    }

  } catch (error) {
    console.error("Submit execution error:", error.message);
    res.status(500).json({
      error: "Failed to submit code",
      details: error.response?.data || error.message
    });
  }
});

export default router;