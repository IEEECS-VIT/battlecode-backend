export const ScoreRound0 = (totalcases, passedcases, submits) => {
    var score = 0;
    var passed_ratio = passedcases/totalcases;
    if (passed_ratio == 1){
        score += 5;
    }
    else{
        score += 4*passed_ratio;
    }

    if (submits > 2){
        score -= 1;
    }
    return score;

};

export const ScoreRound1 = (time_left, totalcases, passedcases, difficulty, win)=>{
    //test case - 30%
    // win - 40%
    //submit - 10%
    //time - 20%
    var total_time = 0;
    var max_score = 0;
    var passed_ratio = passedcases/totalcases;
    var current_score = 0;
    
    switch (difficulty){
        case "EASY":
            total_time = 15*60; //15 mins
            max_score = 20;
            break;
        case "MEDIUM":
            total_time = 20*60; //20 mins
            max_score = 30;
            break;
        case "HARD":
            total_time = 25*60; //25 mins
            max_score = 40;
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

    return current_score;
};
export const ScoreRound2  = (time_left, totalcases, passedcases, difficulty, win, rank_difference)=>{
    //test case - 30%
    // win - 60%
    //submit - 10%
    var total_time = 0;
    var max_score = 0;
    var passed_ratio = passedcases/totalcases;
    var current_score = 0;
    total_time = 25*60; //TBD
    max_score = 60;// TBD
    
    current_score += (max_score * 0.3 * passed_ratio);
    if (win){
        current_score += 0.6*max_score;
    }
    if (submit <= 3){
        current_score += (max_score * 0.1);
    }
    time_ratio = time_left/total_time;
    current_score += (max_score * 0.2 * time_ratio);

    return current_score;
};
export const ScoreRound3 = ()=>{
    return 3;
};

export const Bounty = ()=>{
    
};

export const Hack = () => {
    
}
