-- Sessions are looked up and revoked by user (deactivation, password reset,
-- retention cleanup); action tokens are listed per user for the same reasons.
-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "ActionToken_userId_idx" ON "ActionToken"("userId");
