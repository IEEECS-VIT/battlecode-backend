/*
  Warnings:

  - You are about to drop the column `functionSignatures` on the `Problem` table. All the data in the column will be lost.
  - You are about to drop the column `systemDesign` on the `Problem` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Problem" DROP COLUMN "functionSignatures",
DROP COLUMN "systemDesign";
