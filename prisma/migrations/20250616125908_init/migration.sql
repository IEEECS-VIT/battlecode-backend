/*
  Warnings:

  - You are about to drop the column `category` on the `Problem` table. All the data in the column will be lost.
  - You are about to drop the column `sampleCases` on the `Problem` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[title]` on the table `Problem` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `boilerplate` to the `Problem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `functionSignatures` to the `Problem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sampleTestCases` to the `Problem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `systemDesign` to the `Problem` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `hiddenTestCases` on the `Problem` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `difficulty` on the `Problem` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `status` to the `Submission` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('ONGOING', 'COMPLETED', 'TIMEOUT', 'ABANDONED');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'COMPILATION_ERROR', 'RUNTIME_ERROR');

-- DropForeignKey
ALTER TABLE "Submission" DROP CONSTRAINT "Submission_matchId_fkey";

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "status" "MatchStatus" NOT NULL DEFAULT 'ONGOING';

-- AlterTable
ALTER TABLE "Problem" DROP COLUMN "category",
DROP COLUMN "sampleCases",
ADD COLUMN     "boilerplate" JSONB NOT NULL,
ADD COLUMN     "functionSignatures" JSONB NOT NULL,
ADD COLUMN     "hints" TEXT[],
ADD COLUMN     "sampleTestCases" JSONB NOT NULL,
ADD COLUMN     "systemDesign" JSONB NOT NULL,
DROP COLUMN "hiddenTestCases",
ADD COLUMN     "hiddenTestCases" JSONB NOT NULL,
DROP COLUMN "difficulty",
ADD COLUMN     "difficulty" "Difficulty" NOT NULL;

-- AlterTable
ALTER TABLE "Stats" ADD COLUMN     "maxStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "problemsSolved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "memory" INTEGER,
ADD COLUMN     "runtime" INTEGER,
ADD COLUMN     "status" "SubmissionStatus" NOT NULL,
ALTER COLUMN "matchId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ProblemCategories" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProblemCategories_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE INDEX "_ProblemCategories_B_index" ON "_ProblemCategories"("B");

-- CreateIndex
CREATE UNIQUE INDEX "Problem_title_key" ON "Problem"("title");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProblemCategories" ADD CONSTRAINT "_ProblemCategories_A_fkey" FOREIGN KEY ("A") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProblemCategories" ADD CONSTRAINT "_ProblemCategories_B_fkey" FOREIGN KEY ("B") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
