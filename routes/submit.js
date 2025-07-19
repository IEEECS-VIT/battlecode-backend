// import express from "express";
// import prisma from "../config/prisma.js";
// import axios from "axios";

// const router = express.Router();

// // Judge0 Configuration
// const JUDGE0_API_URL = "https://judge0-ce.p.rapidapi.com";
// const RAPIDAPI_KEY = "0b5a6245acmshe42897578272148p147442jsn2df245c0a08e";
// const RAPIDAPI_HOST = "judge0-ce.p.rapidapi.com";

// // Language IDs mapping (Judge0 language IDs)
// const LANGUAGE_IDS = {
//   cpp: 54,
//   python: 71,
//   javascript: 63,
//   java: 62,
//   c: 50,
// };

// // Helper function to determine submission status from Judge0 status
// const getSubmissionStatus = (judge0StatusId) => {
//   // Status IDs from Judge0 documentation
//   if (judge0StatusId === 3) return "ACCEPTED"; // Accepted
//   if (judge0StatusId === 4) return "WRONG_ANSWER"; // Wrong Answer
//   if (judge0StatusId === 5) return "TIME_LIMIT_EXCEEDED"; // Time Limit Exceeded
//   if (judge0StatusId === 6) return "COMPILATION_ERROR"; // Compilation Error
//   if ([7, 8, 9, 10, 11, 12].includes(judge0StatusId)) return "RUNTIME_ERROR"; // Runtime Error
//   return "PENDING";
// };

// const prepareTestCases = (problem, isSubmit) => {
//   const testCases = isSubmit
//     ? [...problem.sampleTestCases, ...problem.hiddenTestCases]
//     : problem.sampleTestCases;

//   return testCases.map((testCase) => {
//     // Safe input handling
//     let input;
//     try {
//       if (typeof testCase.input === "string") {
//         input = testCase.input;
//       } else if (testCase.input && typeof testCase.input === "object") {
//         // Handle Two Sum format
//         if (testCase.input.nums && testCase.input.target !== undefined) {
//           input = `${testCase.input.target} ${testCase.input.nums.join(" ")}`;
//         }
//         // Handle string wrapped in object
//         else if (testCase.input.s) {
//           input = testCase.input.s;
//         }
//         // Fallback to JSON string
//         else {
//           input = JSON.stringify(testCase.input);
//         }
//       } else {
//         input = String(testCase.input);
//       }
//     } catch (error) {
//       console.error("Error processing input:", error);
//       input = String(testCase.input || "");
//     }

//     // Safe output handling
//     let expectedOutput;
//     try {
//       if (Array.isArray(testCase.output)) {
//         expectedOutput = testCase.output.join(" ");
//       } else {
//         expectedOutput = String(testCase.output);
//       }
//     } catch (error) {
//       console.error("Error processing output:", error);
//       expectedOutput = String(testCase.output || "");
//     }

//     return {
//       input: input,
//       expectedOutput: expectedOutput,
//     };
//   });
// };

// // Submit code to Judge0 with retry logic and rate limiting
// const submitToJudge0 = async (code, language, testCases, retries = 3) => {
//   const config = {
//     headers: {
//       "Content-Type": "application/json",
//       "x-rapidapi-host": RAPIDAPI_HOST,
//       "x-rapidapi-key": RAPIDAPI_KEY,
//     },
//     params: {
//       base64_encoded: "false",
//       wait: "true", // Wait for execution to complete
//       fields: "*",
//     },
//   };

//   // Process test cases sequentially instead of parallel to avoid rate limits
//   const results = [];

//   for (let i = 0; i < testCases.length; i++) {
//     const testCase = testCases[i];
//     let attempt = 0;

//     while (attempt < retries) {
//       try {
//         const submission = {
//           language_id: LANGUAGE_IDS[language] || 54,
//           source_code: code,
//           stdin: testCase.input,
//           expected_output: testCase.expectedOutput,
//         };

//         const response = await axios.post(
//           `${JUDGE0_API_URL}/submissions`,
//           submission,
//           config
//         );
//         results.push(response.data);

//         // Add delay between requests to avoid rate limiting
//         if (i < testCases.length - 1) {
//           await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
//         }
//         break;
//       } catch (error) {
//         attempt++;

//         if (error.response?.status === 429) {
//           // Rate limit hit, wait longer
//           const delay = Math.pow(2, attempt) * 2000; // Exponential backoff
//           console.log(
//             `Rate limit hit, waiting ${delay}ms before retry ${attempt}/${retries}`
//           );
//           await new Promise((resolve) => setTimeout(resolve, delay));

//           if (attempt === retries) {
//             throw new Error(`Rate limit exceeded after ${retries} attempts`);
//           }
//         } else {
//           throw error;
//         }
//       }
//     }
//   }

//   return results;
// };

// // Run endpoint - only executes sample test cases
// router.post("/run", async (req, res) => {
//   try {
//     const { problemId, language, code, userId } = req.body;

//     // Validate inputs
//     if (!problemId || !language || !code) {
//       return res.status(400).json({
//         success: false,
//         error: "Missing required fields: problemId, language, or code",
//       });
//     }

//     // Validate language
//     if (!LANGUAGE_IDS[language]) {
//       return res.status(400).json({
//         success: false,
//         error: `Unsupported language: ${language}`,
//       });
//     }

//     // Get the problem
//     const problem = await prisma.problem.findUnique({
//       where: { id: problemId },
//     });

//     if (!problem) {
//       return res.status(404).json({
//         success: false,
//         error: "Problem not found",
//       });
//     }

//     // Check if problem has sample test cases
//     if (!problem.sampleTestCases || problem.sampleTestCases.length === 0) {
//       return res.status(400).json({
//         success: false,
//         error: "Problem has no sample test cases",
//       });
//     }

//     // Prepare test cases (only sample for run)
//     const testCases = prepareTestCases(problem, false);

//     console.log(
//       `Running ${testCases.length} test cases for problem ${problemId}`
//     );

//     const judge0Results = await submitToJudge0(code, language, testCases);

//     // Process results
//     const results = judge0Results.map((result, index) => ({
//       testCase: problem.sampleTestCases[index].input,
//       status: getSubmissionStatus(result.status.id),
//       runtime: result.time ? parseFloat(result.time) * 1000 : null, // Convert to milliseconds
//       memory: result.memory,
//       output: result.stdout || result.compile_output || result.stderr || "",
//       expectedOutput: problem.sampleTestCases[index].output,
//       isCorrect: result.status.id === 3, // 3 = Accepted in Judge0
//       statusId: result.status.id, // Include for debugging
//       statusDescription: result.status.description,
//     }));

//     // Count passed cases
//     const passedCases = results.filter((r) => r.isCorrect).length;
//     const totalCases = results.length;

//     // Create a submission record (for run attempts) - only if userId provided
//     let submission = null;
//     if (userId) {
//       try {
//         submission = await prisma.submission.create({
//           data: {
//             problemId,
//             playerId: userId,
//             code,
//             language,
//             status: passedCases === totalCases ? "ACCEPTED" : "WRONG_ANSWER",
//             runtime:
//               results.reduce((sum, r) => sum + (r.runtime || 0), 0) /
//               results.length,
//             memory:
//               results.reduce((sum, r) => sum + (r.memory || 0), 0) /
//               results.length,
//             testCasesPassed: passedCases,
//             totalTestCases: totalCases,
//           },
//         });
//       } catch (dbError) {
//         console.error("Error creating submission record:", dbError);
//         // Continue without submission record if DB fails
//       }
//     }

//     res.json({
//       success: true,
//       data: {
//         results,
//         passedCases,
//         totalCases,
//         isAccepted: passedCases === totalCases,
//         submissionId: submission?.id || null,
//       },
//     });
//   } catch (error) {
//     console.error("Error running code:", error);

//     // Handle specific error types
//     if (error.message.includes("Rate limit exceeded")) {
//       return res.status(429).json({
//         success: false,
//         error:
//           "Too many requests to code execution service. Please try again in a few moments.",
//         details: error.message,
//       });
//     }

//     if (error.response?.status === 429) {
//       return res.status(429).json({
//         success: false,
//         error: "Rate limit exceeded. Please wait before trying again.",
//         details: "Too many requests to Judge0 API",
//       });
//     }

//     res.status(500).json({
//       success: false,
//       error: "Failed to run code",
//       details: error.message,
//     });
//   }
// });

// // Submit endpoint - executes all test cases (sample + hidden)
// router.post("/submit", async (req, res) => {
//   try {
//     const { problemId, language, code, userId, matchId } = req.body;

//     // Validate inputs
//     if (!problemId || !language || !code || !userId) {
//       return res.status(400).json({
//         success: false,
//         error: "Missing required fields: problemId, language, code, or userId",
//       });
//     }

//     // Validate language
//     if (!LANGUAGE_IDS[language]) {
//       return res.status(400).json({
//         success: false,
//         error: `Unsupported language: ${language}`,
//       });
//     }

//     // Get the problem
//     const problem = await prisma.problem.findUnique({
//       where: { id: problemId },
//     });

//     if (!problem) {
//       return res.status(404).json({
//         success: false,
//         error: "Problem not found",
//       });
//     }

//     // Check if problem has test cases
//     const totalTestCases =
//       (problem.sampleTestCases?.length || 0) +
//       (problem.hiddenTestCases?.length || 0);
//     if (totalTestCases === 0) {
//       return res.status(400).json({
//         success: false,
//         error: "Problem has no test cases",
//       });
//     }

//     // Prepare all test cases (sample + hidden)
//     const testCases = prepareTestCases(problem, true);

//     console.log(
//       `Submitting ${testCases.length} test cases for problem ${problemId}`
//     );

//     const judge0Results = await submitToJudge0(code, language, testCases);

//     // Process results
//     const results = judge0Results.map((result, index) => {
//       const isFromSample = index < (problem.sampleTestCases?.length || 0);
//       const testCaseData = isFromSample
//         ? problem.sampleTestCases[index]
//         : problem.hiddenTestCases[
//             index - (problem.sampleTestCases?.length || 0)
//           ];

//       return {
//         testCase: testCaseData.input,
//         status: getSubmissionStatus(result.status.id),
//         runtime: result.time ? parseFloat(result.time) * 1000 : null,
//         memory: result.memory,
//         output: result.stdout || result.compile_output || result.stderr || "",
//         expectedOutput: testCaseData.output,
//         isCorrect: result.status.id === 3,
//         statusId: result.status.id,
//         statusDescription: result.status.description,
//         isHidden: !isFromSample,
//       };
//     });

//     // Count passed cases
//     const passedCases = results.filter((r) => r.isCorrect).length;
//     const totalCases = results.length;
//     const isAccepted = passedCases === totalCases;

//     // Create submission record
//     const submission = await prisma.submission.create({
//       data: {
//         problemId,
//         playerId: userId,
//         matchId: matchId || null,
//         code,
//         language,
//         status: isAccepted ? "ACCEPTED" : "WRONG_ANSWER",
//         runtime:
//           results.reduce((sum, r) => sum + (r.runtime || 0), 0) /
//           results.length,
//         memory:
//           results.reduce((sum, r) => sum + (r.memory || 0), 0) / results.length,
//         testCasesPassed: passedCases,
//         totalTestCases: totalCases,
//       },
//       include: {
//         problem: true,
//         player: true,
//         match: true,
//       },
//     });

//     // If this was part of a match and the submission was accepted, update match status
//     if (matchId && isAccepted) {
//       try {
//         await prisma.match.update({
//           where: { id: matchId },
//           data: {
//             status: "COMPLETED",
//             winnerId: userId,
//             updatedAt: new Date(),
//           },
//         });

//         // Update user stats (problems solved)
//         await prisma.stats.upsert({
//           where: { userId },
//           update: {
//             problemsSolved: { increment: 1 },
//           },
//           create: {
//             userId,
//             problemsSolved: 1,
//             matchesPlayed: 0,
//             matchesWon: 0,
//           },
//         });
//       } catch (updateError) {
//         console.error("Error updating match/stats:", updateError);
//         // Continue - submission was successful even if match update failed
//       }
//     }

//     res.json({
//       success: true,
//       data: {
//         isAccepted,
//         passedCases,
//         totalCases,
//         results: results.map((r) => ({
//           ...r,
//           // Hide output for hidden test cases if submission failed
//           output: r.isHidden && !isAccepted ? "[Hidden]" : r.output,
//           expectedOutput:
//             r.isHidden && !isAccepted ? "[Hidden]" : r.expectedOutput,
//         })),
//         submission,
//       },
//     });
//   } catch (error) {
//     console.error("Error submitting code:", error);

//     // Handle specific error types
//     if (error.message.includes("Rate limit exceeded")) {
//       return res.status(429).json({
//         success: false,
//         error:
//           "Too many requests to code execution service. Please try again in a few moments.",
//         details: error.message,
//       });
//     }

//     if (error.response?.status === 429) {
//       return res.status(429).json({
//         success: false,
//         error: "Rate limit exceeded. Please wait before trying again.",
//         details: "Too many requests to Judge0 API",
//       });
//     }

//     res.status(500).json({
//       success: false,
//       error: "Failed to submit code",
//       details: error.message,
//     });
//   }
// });

// // Get submission details
// router.get("/:id", async (req, res) => {
//   try {
//     const { id } = req.params;

//     const submission = await prisma.submission.findUnique({
//       where: { id },
//       include: {
//         problem: true,
//         player: true,
//         match: true,
//       },
//     });

//     if (!submission) {
//       return res.status(404).json({
//         success: false,
//         error: "Submission not found",
//       });
//     }

//     res.json({
//       success: true,
//       data: submission,
//     });
//   } catch (error) {
//     console.error("Error fetching submission:", error);
//     res.status(500).json({
//       success: false,
//       error: "Failed to fetch submission",
//       details: error.message,
//     });
//   }
// });

// export default router;

const express = require("express");
const axios = a_x_i_o_s; // A_X_I_O_S is used for HTTP requests
const router = express.Router();

// Your self-hosted Judge0 API endpoint
const JUDGE0_API_URL = "http://localhost:2358";

// A mapping from your language names to Judge0 language IDs
const LANGUAGE_ID_MAP = {
  cpp: 54,
  python: 71,
  javascript: 63,
  java: 62,
  c: 50,
};

/**
 * Sleeps for a given amount of time.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /submit
 * Expects a body like:
 * {
 * "language": "python",
 * "source_code": "...",
 * "testCases": [ { "input": "...", "output": "..." }, ... ]
 * }
 */
router.post("/", async (req, res) => {
  const { language, source_code, testCases } = req.body;

  if (!language || !source_code || !testCases) {
    return res
      .status(400)
      .json({
        error: "Missing required fields: language, source_code, or testCases.",
      });
  }

  const language_id = LANGUAGE_ID_MAP[language];
  if (!language_id) {
    return res.status(400).json({ error: `Unsupported language: ${language}` });
  }

  // 1. Create the batch submission payload for Judge0
  const submissions = testCases.map((testCase) => ({
    language_id,
    source_code,
    stdin: testCase.input,
    expected_output: String(testCase.output) + "\n", // Ensure output is a string with a newline
  }));

  try {
    // 2. Send the batch submission request to Judge0
    const submissionResponse = await a_x_i_o_s.post(
      `${JUDGE0_API_URL}/submissions/batch?base64_encoded=false`,
      {
        submissions,
      }
    );

    const tokens = submissionResponse.data;

    // 3. Poll Judge0 for the results using the tokens
    const results = [];
    for (const token of tokens) {
      let submissionResult;
      while (true) {
        const resultResponse = await a_x_i_o_s.get(
          `${JUDGE0_API_URL}/submissions/${token.token}?base64_encoded=false`
        );
        const statusId = resultResponse.data.status.id;

        // If status is 1 (In Queue) or 2 (Processing), wait and poll again
        if (statusId === 1 || statusId === 2) {
          await sleep(2000); // Wait for 2 seconds before checking again
        } else {
          submissionResult = resultResponse.data;
          break; // Exit loop for this token
        }
      }
      results.push(submissionResult);
    }

    // 4. Send the final results back to the client
    res.status(200).json({ results });
  } catch (error) {
    console.error(
      "Error communicating with Judge0:",
      error.response ? error.response.data : error.message
    );
    res
      .status(500)
      .json({ error: "An error occurred while evaluating the code." });
  }
});

module.exports = router;
