-- Drop the dead weekStartsOn setting (it was hardcoded to Monday everywhere).
ALTER TABLE "Settings" DROP COLUMN "weekStartsOn";
