//submits are the number of submits for a particular questions NOT ROUND
export const ScoreRound0 = (totalcases, passedcases, submits) => {
    var score = 0;
    var passed_ratio = passedcases/totalcases;
    if (passed_ratio == 1){
        score += 50;
    }
    else{
        score += 40*passed_ratio;
    }

    if (submits > 2){
        score -= 10;
    }
    return score;

};

export const ScoreRound1 = (time_left, totalcases, passedcases, difficulty, win, submits)=>{
    //test case - 30%
    // win - 40%
    //submit - 10%
    //time - 20%
    var total_time = 0;
    var max_score = 0;
    var passed_ratio = passedcases/totalcases;
    var current_score = 0;
    
    switch (difficulty){
        case "R1_EASY":
            total_time = 15*60; //15 mins
            max_score = 200;
            break;
        case "R1_MEDIUM":
            total_time = 20*60; //20 mins
            max_score = 300;
            break;
        case "R1_HARD":
            total_time = 25*60; //25 mins
            max_score = 400;
            break;
    }
    current_score += (max_score * 0.3 * passed_ratio);
    if (win){
        current_score += (max_score * 0.4);
    }
    if (submits <= 3){
        current_score += (max_score * 0.1);
    }
    var time_formula = max_score * 0.2 * Math.exp(-0.00256 * (total_time - time_left));
    current_score += time_formula;

    return current_score;
};
export const ScoreRound2  = (time_left, totalcases, passedcases, difficulty, win, iselite)=>{
    //test case - 30%
    // win - 40%
    //submit - 10%
    //time - 20%
    var total_time = 0;
    var max_score = 0;
    var passed_ratio = passedcases/totalcases;
    var current_score = 0;
    
    switch (difficulty){
        case "R2_EASY":
            total_time = 15*60; //15 mins
            max_score = 300;
            break;
        case "R2_MEDIUM":
            total_time = 20*60; //20 mins
            max_score = 400;
            break;
        case "R2_HARD":
            total_time = 25*60; //25 mins
            max_score = 500;
            break;
    }
    current_score += (max_score * 0.3 * passed_ratio);
    if (win){
        current_score += (max_score * 0.4);
    }
    if (submit <= 3){
        current_score += (max_score * 0.1);
    }
    var time_formula = max_score * 0.2 * Math.exp(-0.00256 * (total_time - time_left));
    current_score += time_formula;
    if (iselite){
        current_score *= 0.75;
    }
    else{
        current_score *= 1.25;
    }

    return current_score;
};
export const ScoreRound3 = ()=>{
        return 750;
};

export const Bounty = (difficulty, submits)=>{
    switch (difficulty){
        case "EASY":
            return 200;
        case "MEDIUM":
            return 300;
        case "HARD":
            return 400;

    }
    if (submits < 3){
        return -40;
    }
};

export const Hack = (gothacked) => {
    // if gothacked is true, the user got hacked if false the user hacked someone
    if (gothacked){
        return -25;
    }
    return 40;
}