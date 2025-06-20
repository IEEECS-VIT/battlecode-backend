import prisma  from "../config/prisma.js";

export async function GetQuestions (language,noOfQuestions,difficulty,randomize=true){

  const languageIDMap = {
    python: 71,
    cpp: 54,
    c:50,
    java: 62,
  }

  //checking

  if (!language || typeof language !=='string')
  {
    console.error('Invalid language entered.')
    return []
  }

  if (!noOfQuestions || noOfQuestions<=0)
  {
    console.error('Invalid number of questions entered.')
    return []
  }

  const languageID=languageIDMap[language.toLowerCase()]
  if(!languageID)
  {
    console.error('language is not supported.')
    return []
  }

  const queryOptions = {    //pass to findMany
    where:{
      language_id:languageID,
      difficulty: difficulty,
    },
    take:noOfQuestions
    }

    //to give random questions
    if(randomize)
    {
      queryOptions.orderBy=[{id:'desc'}];  //prisma requires orderby when using skip

    const totalQuestions = await prisma.question.count({
      where:{
        language_id:languageID,
        difficulty: difficulty,
      }
    })

    if(totalQuestions>noOfQuestions)
    {
      const maxSkip=Math.max(0,totalQuestions-noOfQuestions) //num of q skipped will be 0 or the diff
      const randomSkip = Math.floor(Math.random() * maxSkip); 
      queryOptions.skip = randomSkip;
    }
  }
  else
  {
     queryOptions.orderBy=[{id:'desc'}];
  }

  const questions=await prisma.question.findMany(queryOptions)
  return questions
}