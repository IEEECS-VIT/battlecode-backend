// ---------------------------------------------------------------------------
// Scoring tuning constants
//
// This event is a single ~12 hour sprint run by first-years, so the curves are
// deliberately forgiving: partial work always pays, and the penalties for
// iterating on a solution are small and recoverable.
//
// Every change here is bounded so that (a) no input scores LOWER than it did
// under the previous revision, and (b) the per-problem maximum is unchanged.
// That keeps the leaderboard shape and the admin-side qualification cutoffs
// behaving the way they did before.
// ---------------------------------------------------------------------------

// passed_ratio at (or above) which the submit-count/time bonuses pay in full.
const CORRECTNESS_THRESHOLD = 0.8;
// passed_ratio below which those bonuses pay nothing at all. Between this and
// CORRECTNESS_THRESHOLD they ramp linearly instead of switching on at a cliff.
const BONUS_RAMP_START = 0.5;

// Free submissions before the submit-count penalty/bonus-loss applies.
const R0_FREE_SUBMITS = 4;
const R12_FREE_SUBMITS = 5;
const BOUNTY_FREE_SUBMITS = 5;

// Time-bonus decay. Half-life = ln(2)/RATE. At 0.0008 that is ~14.4 minutes,
// which actually spans a 15-25 minute problem window. (The previous 0.00256
// gave a 4.5 minute half-life, so the time component was effectively dead.)
const TIME_DECAY_RATE = 0.0008;

/**
 * How much of the "bonus" pool (submit-count + time) a given correctness ratio
 * unlocks. Replaces the old hard `if (passed_ratio >= 0.8)` step, which made a
 * single hidden test case worth ~30% of a problem.
 *
 * Returns 1.0 at/above CORRECTNESS_THRESHOLD, so anyone who cleared the old
 * bar is unaffected; below it the bonuses fade out instead of vanishing.
 */
const bonusFactor = (passed_ratio) => {
    if (passed_ratio >= CORRECTNESS_THRESHOLD) return 1;
    if (passed_ratio <= BONUS_RAMP_START) return 0;
    return (passed_ratio - BONUS_RAMP_START) / (CORRECTNESS_THRESHOLD - BONUS_RAMP_START);
};

const safeRatio = (totalcases, passedcases) => {
    if (!totalcases || totalcases <= 0) return 0;
    return Math.min(1, Math.max(0, passedcases / totalcases));
};

//submits are the number of submits for a particular questions NOT ROUND
export const ScoreRound0 = (totalcases, passedcases, submits) => {
    var passed_ratio = safeRatio(totalcases, passedcases);

    // Was: ratio === 1 ? 50 : 40 * ratio  -- a 26% jump for the last test case.
    // Now the same 50 max, but partial work is paid proportionally.
    var score = 45 * passed_ratio;
    if (passed_ratio === 1) {
        score += 5;
    }

    // Was: -10 after 2 submits. Because the best score is kept forever, that
    // capped anyone who needed 3 attempts at 40/50 permanently.
    if (submits > R0_FREE_SUBMITS) {
        score -= 5;
    }

    return Math.max(0, score);

}; //450 max

export const ScoreRound1 = (time_left, totalcases, passedcases, difficulty, win, submits) => {
    //test case - 30%
    // win - 40%
    //submit - 10%
    //time - 20%
    var total_time = 0;
    var max_score = 0;
    var passed_ratio = safeRatio(totalcases, passedcases);
    var current_score = 0;

    switch (difficulty) {
        case "R1_EASY":
            total_time = 15 * 60; //15 mins
            max_score = 200;
            break;
        case "R1_MEDIUM":
            total_time = 20 * 60; //20 mins
            max_score = 300;
            break;
        case "R1_HARD":
            total_time = 25 * 60; //25 mins
            max_score = 400;
            break;
        default:
            return 0;
    }

    current_score += (max_score * 0.3 * passed_ratio);
    if (win) {
        current_score += (max_score * 0.4);
    }

    var bonus = bonusFactor(passed_ratio);
    if (bonus > 0) {
        if (submits <= R12_FREE_SUBMITS) {
            current_score += (max_score * 0.1 * bonus);
        }
        var elapsed = Math.min(total_time, Math.max(0, total_time - time_left));
        var time_formula = max_score * 0.2 * bonus * Math.exp(-TIME_DECAY_RATE * elapsed);
        current_score += time_formula;
    }

    return Math.max(0, current_score);
};

//1200 maxx

export const ScoreRound2 = (time_left, totalcases, passedcases, difficulty, win, iselite, submits) => {
    //test case - 30%
    // win - 40%
    //submit - 10%
    //time - 20%
    var total_time = 0;
    var max_score = 0;
    var passed_ratio = safeRatio(totalcases, passedcases);
    var current_score = 0;

    total_time = 20 * 60; //20 mins
    max_score = 400;


    current_score += (max_score * 0.3 * passed_ratio);
    if (win) {
        current_score += (max_score * 0.4);
    }

    var bonus = bonusFactor(passed_ratio);
    if (bonus > 0) {
        if (submits <= R12_FREE_SUBMITS) {
            current_score += (max_score * 0.1 * bonus);
        }
        var elapsed = Math.min(total_time, Math.max(0, total_time - time_left));
        var time_formula = max_score * 0.2 * bonus * Math.exp(-TIME_DECAY_RATE * elapsed);
        current_score += time_formula;
    }

    if (iselite) {
        current_score *= 0.75;
    }
    else {
        current_score *= 1.25;
    }

    return Math.max(0, current_score);
};



export const ScoreRound3 = (totalcases, passedcases, submits) => {
    var passed_ratio = safeRatio(totalcases, passedcases);

    // Was: ratio === 1 ? 600 : 400 * ratio -- a 204 point (51%) jump for the
    // last test case, the largest cliff in the event. Same 600 max, but the
    // gap between "nearly there" and "done" is now proportional.
    var score = 500 * passed_ratio;
    if (passed_ratio === 1) {
        score += 100;
    }

    return Math.max(0, score);

    // you lose 100 points if you get hacked
    // gain 100 points if you hack someone elses code
    // NOTE: not implemented. HackAttempt rows are created by
    // round3.handler.js but never reviewed, and emitHackResult() is never
    // called, so hacking currently awards nothing either way.

};

export const ScoreBounty = (difficulty, submits, totalcases, passedcases) => {
    var passed_ratio = safeRatio(totalcases, passedcases);

    var base = 0;
    switch (difficulty) {
        case "EASY":
            base = 100;
            break;
        case "MEDIUM":
            base = 150;
            break;
        case "HARD":
            base = 250;
            break;
        default:
            // Fall back to MEDIUM rather than silently scoring 0. The route
            // currently hardcodes "MEDIUM" because the schema only has a
            // single R2_BOUNTY difficulty; if that call site ever changes,
            // an unmapped value should not wipe out everyone's bounty points.
            base = 150;
            break;

    }

    // Was: all-or-nothing -- 95% of tests passing scored 0. Every other round
    // pays partial credit, so bounties now do too. A full solve still pays the
    // same `base` it always did.
    var score = base * 0.6 * passed_ratio;
    if (passed_ratio === 1) {
        score += base * 0.4;
    }

    // Was: `score = -40`, which OVERWROTE the score -- a correct solution on
    // attempt 4 scored worse than never attempting. Now it subtracts, and the
    // result is floored at 0.
    if (submits > BOUNTY_FREE_SUBMITS) {
        score -= 20;
    }

    return Math.max(0, score);
};

// export const Hack = (gothacked) => {
//     // if gothacked is true, the user got hacked if false the user hacked someone
//     if (gothacked) {
//         return -25;
//     }
//     return 40;
// }

// export const ScoreCC = (totalcases, passedcases, win) => {
//     let score = 0;
//     if (win) {
//         score += 50;
//     }

//     score += 50 * passedcases / totalcases;
//     return score;
// }
