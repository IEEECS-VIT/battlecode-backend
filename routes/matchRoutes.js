import express from "express";
import verifyAuthToken from "../middleware/authMiddleware.js";
import redis from "../config/redis.js"

const router= express.Router()

const getMatchKey = (matchId) => `match:${matchId}`

router.post("/submit",verifyAuthToken,async(req,res)=>{
    const {matchId,answer,language}=req.body;
    const userId=req.user.id;

    if (!matchId || !answer || !language) {
      return res.status(400).json({ error: "Missing matchId, answer, or language" });
    }

    const matchDataRaw=await redis.get(getMatchKey(matchId));

    if (!matchDataRaw) 
    {
       return res.status(404).json({ error: "Match not found or expired" });
    }

    const match = JSON.parse(matchDataRaw)

    const index = match.currentQuestionIndex
    const currentQuestion = match.questions[index]

    const passed = true;   //placeholder logic for answer validation

    match.currentQuestionIndex += 1;
    await redis.setex(getMatchKey(matchId),86400,JSON.stringify(match))

    if (match.currentQuestionIndex >= match.questions.length) 
    {
        return res.json({ message: "Match completed" });
    }

    const nextQuestion = match.questions[match.currentQuestionIndex];

    return res.json({
      success: true,
      nextQuestion,
      currentQuestionIndex: match.currentQuestionIndex,
    });

})

export default router;
