import prisma from "./config/prisma.js";

async function main() {
  console.log('Start seeding for Two Sum problem...');

  // 1. Upsert Categories
  const categoriesData = [
    { name: 'Array' },
    { name: 'Hash Table' },
  ];

  const categoryUpserts = categoriesData.map(cat => 
    prisma.category.upsert({
      where: { name: cat.name },
      update: {},
      create: { name: cat.name },
    })
  );
  const categories = await Promise.all(categoryUpserts);
  console.log('Categories seeded:', categories.map(c => c.name).join(', '));
  
  const categoryIds = categories.map(c => ({ id: c.id }));

  // 2. Get Round 0 (assuming it already exists)
  const round = await prisma.round.findUnique({
    where: { roundNumber: 0 },
  });
  
  if (!round) {
    throw new Error('Round 0 not found in database. Please ensure rounds are seeded first.');
  }
  
  console.log(`Using existing Round ${round.roundNumber}.`);

  // 3. Define the Problem Data
  const problemTitle = "Two Sum";
  const problemData = {
    title: problemTitle,
    description: "Given an array of integers `nums` and an integer `target`, return indices of the two numbers such that they add up to `target`.\n\nYou may assume that each input would have exactly one solution, and you may not use the same element twice.\n\nYou can return the answer in any order.",
    difficulty: 'R0',
    constraints: [
      "2 <= nums.length <= 10^4",
      "-10^9 <= nums[i] <= 10^9",
      "-10^9 <= target <= 10^9",
      "Only one valid answer exists.",
    ],
    hints: [
      "A brute-force approach would involve checking every pair of elements.",
      "Can you use a hash map to optimize the search for the complement of each element?"
    ],
    boilerplate: {
      cpp: "#include <iostream>\n#include <vector>\n#include <string>\n#include <sstream>\n#include <unordered_map>\n\nusing namespace std;\n\nvector<int> twoSum(vector<int>& nums, int target) {\n    // Your code here\n}\n\nint main() {\n    ios_base::sync_with_stdio(false);\n    cin.tie(NULL);\n\n    string line;\n    \n    // Read the array line\n    getline(cin, line);\n    stringstream ss(line);\n    int num;\n    vector<int> nums;\n    while (ss >> num) {\n        nums.push_back(num);\n    }\n\n    // Read the target line\n    int target;\n    cin >> target;\n\n    vector<int> result = twoSum(nums, target);\n\n    cout << \"[\" << result[0] << \",\" << result[1] << \"]\" << endl;\n\n    return 0;\n}",
      c: "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n\n/**\n * Note: The returned array must be malloced, assume caller calls free().\n */\nint* twoSum(int* nums, int numsSize, int target, int* returnSize) {\n    // Your code here\n    *returnSize = 0;\n    return NULL;\n}\n\nint* parse_input_nums(char* line, int* count) {\n    int capacity = 10;\n    int* nums = malloc(capacity * sizeof(int));\n    int i = 0;\n    char* token = strtok(line, \" \\t\\n\");\n    while (token != NULL) {\n        if (i >= capacity) {\n            capacity *= 2;\n            nums = realloc(nums, capacity * sizeof(int));\n        }\n        nums[i++] = atoi(token);\n        token = strtok(NULL, \" \\t\\n\");\n    }\n    *count = i;\n    return nums;\n}\n\nint main() {\n    char line[100000];\n    \n    fgets(line, sizeof(line), stdin);\n    char* newline = strchr(line, '\\n');\n    if (newline) *newline = '\\0';\n    \n    int numsSize = 0;\n    int* nums = parse_input_nums(line, &numsSize);\n\n    int target;\n    scanf(\"%d\", &target);\n    \n    int returnSize = 0;\n    int* result = twoSum(nums, numsSize, target, &returnSize);\n\n    if (result != NULL && returnSize == 2) {\n        printf(\"[%d,%d]\\n\", result[0], result[1]);\n        free(result);\n    } else {\n        printf(\"[]\\n\");\n    }\n\n    free(nums);\n    \n    return 0;\n}",
      python: "import sys\n\nclass Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        # Your code here\n        pass\n\nif __name__ == \"__main__\":\n    solver = Solution()\n    \n    nums_line = sys.stdin.readline().strip()\n    nums = [int(x) for x in nums_line.split()]\n    \n    target = int(sys.stdin.readline().strip())\n    \n    result = solver.twoSum(nums, target)\n    \n    print(f\"[{result[0]},{result[1]}]\")\n",
      java: "import java.io.BufferedReader;\nimport java.io.InputStreamReader;\nimport java.io.IOException;\nimport java.util.Arrays;\nimport java.util.HashMap;\nimport java.util.Map;\n\nclass Solution {\n    public int[] twoSum(int[] nums, int target) {\n        // Your code here\n        return new int[0];\n    }\n\n    public static void main(String[] args) throws IOException {\n        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));\n        \n        String numsLine = reader.readLine();\n        String[] numsStr = numsLine.trim().split(\"\\\\s+\");\n        int[] nums = new int[numsStr.length];\n        for (int i = 0; i < numsStr.length; i++) {\n            nums[i] = Integer.parseInt(numsStr[i]);\n        }\n        \n        int target = Integer.parseInt(reader.readLine().trim());\n        \n        Solution solution = new Solution();\n        int[] result = solution.twoSum(nums, target);\n        \n        System.out.println(\"[\" + result[0] + \",\" + result[1] + \"]\");\n    }\n}"
    },
    sampleTestCases: [
      {
        stdin: "2 7 11 15\n9",
        expected_output: "[0,1]\n"
      },
      {
        stdin: "3 2 4\n6",
        expected_output: "[1,2]\n"
      },
      {
        stdin: "3 3\n6",
        expected_output: "[0,1]\n"
      }
    ],
    hiddenTestCases: [
       {
        stdin: "-1 -2 -3 -4 -5\n-8",
        expected_output: "[2,4]\n"
       },
       {
        stdin: "0 4 3 0\n0",
        expected_output: "[0,3]\n"
       },
       {
        stdin: "100 200 350 400\n750",
        expected_output: "[2,3]\n"
       }
    ],
    avgTimeComplexity: "O(N)",
    avgSpaceComplexity: "O(N)",
    roundId: round.roundNumber,
  };

  // 4. Upsert the problem, connecting it to the categories
  await prisma.problem.upsert({
    where: { title: problemTitle },
    update: {
      ...problemData,
      categories: {
        set: categoryIds, // A simpler way to manage connections on update
      },
    },
    create: {
      ...problemData,
      categories: {
        connect: categoryIds,
      },
    },
  });
  console.log(`Successfully seeded problem: "${problemTitle}"`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('Seeding finished.');
  });