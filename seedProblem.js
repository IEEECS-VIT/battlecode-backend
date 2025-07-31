import prisma from "./config/prisma.js"

async function main() {
  // First, create or get the categories
  const arrayCategory = await prisma.category.upsert({
    where: { name: 'Array' },
    update: {},
    create: {
      name: 'Array',
    },
  });

  const hashTableCategory = await prisma.category.upsert({
    where: { name: 'Hash Table' },
    update: {},
    create: {
      name: 'Hash Table',
    },
  });

  // Create the Two Sum problem
  const twoSumProblem = await prisma.problem.create({
    data: {
      title: 'Two Sum',
      description: 'Given an array of integers `nums` and an integer `target`, return indices of the two numbers such that they add up to `target`.\n\nYou may assume that each input would have exactly one solution, and you may not use the same element twice.\n\nYou can return the answer in any order.',
      difficulty: 'EASY',
      constraints: [
        '2 <= nums.length <= 10^4',
        '-10^9 <= nums[i] <= 10^9',
        '-10^9 <= target <= 10^9',
        'Only one valid answer exists.'
      ],
      hints: [
        'A really brute force way would be to search for all possible pairs of numbers',
        'Use a hash table to store the difference between target and current element'
      ],
      avgTimeComplexity: 'O(n)',
      avgSpaceComplexity: 'O(n)',
      boilerplate: {
        c: '#include <stdio.h>\n#include <stdlib.h>\n\nint* twoSum(int* nums, int numsSize, int target, int* returnSize) {\n    // USER IMPLEMENTS THIS\n}\n\n// HIDDEN JUDGE CODE\nint main() {\n    char line[1024];\n    while (fgets(line, sizeof(line), stdin)) {\n        int target;\n        int nums[100];\n        int numsSize = 0;\n        \n        char* p = line;\n        sscanf(p, \"%d\", &target);\n        while (*p && *p != \' \') p++;\n        while (*p) {\n            if (*p == \' \') p++;\n            if (sscanf(p, \"%d\", &nums[numsSize]) == 1) {\n                numsSize++;\n                while (*p && *p != \' \') p++;\n            }\n        }\n        \n        int returnSize;\n        int* result = twoSum(nums, numsSize, target, &returnSize);\n        printf(\"%d %d\\n\", result[0], result[1]);\n        free(result);\n    }\n    return 0;\n}',
        cpp: '#include <iostream>\n#include <vector>\n#include <sstream>\nusing namespace std;\n\nvector<int> twoSum(vector<int>& nums, int target) {\n    // USER IMPLEMENTS THIS\n}\n\n// HIDDEN JUDGE CODE\nint main() {\n    string line;\n    while (getline(cin, line)) {\n        istringstream iss(line);\n        int target;\n        vector<int> nums;\n        \n        // Parse input\n        iss >> target;\n        int num;\n        while (iss >> num) nums.push_back(num);\n        \n        // Execute user function\n        vector<int> result = twoSum(nums, target);\n        \n        // Output result\n        for (int n : result) cout << n << \' \';\n        cout << endl;\n    }\n    return 0;\n}',
        java: 'import java.util.*;\nimport java.io.*;\n\npublic class Main {\n    public static int[] twoSum(int[] nums, int target) {\n        // USER IMPLEMENTS THIS\n    }\n\n    // HIDDEN JUDGE CODE\n    public static void main(String[] args) throws IOException {\n        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));\n        String line;\n        while ((line = br.readLine()) != null) {\n            String[] parts = line.split(\" \");\n            int target = Integer.parseInt(parts[0]);\n            int[] nums = new int[parts.length - 1];\n            for (int i = 1; i < parts.length; i++) {\n                nums[i - 1] = Integer.parseInt(parts[i]);\n            }\n            int[] result = twoSum(nums, target);\n            System.out.println(result[0] + \" \" + result[1]);\n        }\n    }\n}',
        python: 'from typing import List\nimport sys\nimport json\n\ndef twoSum(nums: List[int], target: int) -> List[int]:\n    # USER IMPLEMENTS THIS\n\n# HIDDEN JUDGE CODE\nif __name__ == \"__main__\":\n    for line in sys.stdin:\n        data = json.loads(line)\n        result = twoSum(data[\'nums\'], data[\'target\'])\n        print(json.dumps(result))',
        javascript: 'const readline = require(\'readline\');\n\nfunction twoSum(nums, target) {\n    // USER IMPLEMENTS THIS\n}\n\n// HIDDEN JUDGE CODE\nconst rl = readline.createInterface({\n  input: process.stdin,\n  output: process.stdout\n});\n\nrl.on(\'line\', (input) => {\n    const data = JSON.parse(input);\n    const result = twoSum(data.nums, data.target);\n    console.log(JSON.stringify(result));\n});'
      },
      sampleTestCases: [
        {
          input: {
            stdin: "9 2 7 11 15",
            json: "{\"nums\": [2, 7, 11, 15], \"target\": 9}"
          },
          output: {
            stdout: "0 1",
            json: [0, 1]
          },
          explanation: "Because nums[0] + nums[1] == 9, we return [0, 1]."
        },
        {
          input: {
            stdin: "6 3 2 4",
            json: "{\"nums\": [3, 2, 4], \"target\": 6}"
          },
          output: {
            stdout: "1 2",
            json: [1, 2]
          },
          explanation: "Because nums[1] + nums[2] == 6, we return [1, 2]."
        }
      ],
      hiddenTestCases: [
        {
          input: {
            stdin: "9 1 2 3 4 5",
            json: "{\"nums\": [1, 2, 3, 4, 5], \"target\": 9}"
          },
          output: {
            stdout: "3 4",
            json: [3, 4]
          }
        },
        {
          input: {
            stdin: "-8 -1 -2 -3 -4 -5",
            json: "{\"nums\": [-1, -2, -3, -4, -5], \"target\": -8}"
          },
          output: {
            stdout: "2 4",
            json: [2, 4]
          }
        }
      ],
      categories: {
        connect: [
          { id: arrayCategory.id },
          { id: hashTableCategory.id }
        ]
      }
    }
  });

  console.log('Seeded problem:', twoSumProblem);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });