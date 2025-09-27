import prisma from "./config/prisma.js";

async function main() {
  console.log("Start seeding for LC-70 problem...");

  // 1. Upsert Categories
  const categoriesData = [{ name: "Dynamic Programming" }, { name: "Math" }, { name: "Fibonacci" }];
  const categoryUpserts = categoriesData.map((cat) =>
    prisma.category.upsert({
      where: { name: cat.name },
      update: {},
      create: { name: cat.name },
    })
  );
  const categories = await Promise.all(categoryUpserts);
  console.log("Categories seeded:", categories.map((c) => c.name).join(", "));

  const categoryIds = categories.map((c) => ({ id: c.id }));

  // 2. Get Round 1 (assuming it already exists)
  const round = await prisma.round.findUnique({
    where: { roundNumber: 1 },
  });

  if (!round) {
    throw new Error("Round 1 not found in database. Please ensure rounds are seeded first.");
  }

  console.log(`Using existing Round ${round.roundNumber}.`);

  // 3. Define the Problem Data
  const problemTitle = "Climbing Stairs"; // LC-70
  const problemData = {
    title: problemTitle,
    description:
      "You are climbing a staircase with n steps. Each time you can either climb 1 or 2 steps. " +
      "Return the number of distinct ways to reach the top.\n\n" +
      "Input Format:\n" +
      "A single integer n.\n\n" +
      "Output Format:\n" +
      "A single integer: the number of distinct ways to climb to the top.\n",
    difficulty: "R1_EASY",
    constraints: [
      "1 <= n <= 45",
    ],
    hints: [
      "Let f[i] be ways to reach step i; then f[i] = f[i-1] + f[i-2] with f[0]=1, f[1]=1.",
      "Space-opt: keep only the last two values while iterating up to n.",
      "This is the Fibonacci sequence shifted by one index.",
    ],
    boilerplate: {
      python: ``,
      cpp: ``,
      java: ``,
      c: ``,
    },
   sampleTestCases: [
{
"stdin": "1\n",
"expected_output": "1\n"
},
{
"stdin": "2\n",
"expected_output": "2\n"
}
],
hiddenTestCases: [
{
"stdin": "3\n",
"expected_output": "3\n"
},
{
"stdin": "4\n",
"expected_output": "5\n"
},
{
"stdin": "5\n",
"expected_output": "8\n"
},
{
"stdin": "6\n",
"expected_output": "13\n"
},
{
"stdin": "7\n",
"expected_output": "21\n"
},
{
"stdin": "8\n",
"expected_output": "34\n"
},
{
"stdin": "9\n",
"expected_output": "55\n"
},
{
"stdin": "10\n",
"expected_output": "89\n"
},
{
"stdin": "20\n",
"expected_output": "10946\n"
},
{
"stdin": "25\n",
"expected_output": "121393\n"
},
{
"stdin": "30\n",
"expected_output": "1346269\n"
},
{
"stdin": "35\n",
"expected_output": "14930352\n"
},
{
"stdin": "40\n",
"expected_output": "165580141\n"
}
],
    avgTimeComplexity: "O(n)",
    avgSpaceComplexity: "O(1)",
    roundId: round.roundNumber,
  };

  // 4. Upsert the problem, connecting it to the categories
  await prisma.problem.upsert({
    where: { title: problemTitle },
    update: {
      ...problemData,
      categories: { set: categoryIds },
    },
    create: {
      ...problemData,
      categories: { connect: categoryIds },
    },
  });

  console.log(`Successfully seeded problem: \"" + problemTitle + "\"`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log("Seeding finished.");
  });
