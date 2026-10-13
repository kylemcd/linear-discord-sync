-- 1 once the thread has dropped off Discord's active-thread list and the bot
-- confirmed it still exists (archived). Reset when it becomes active again.
-- Lets the 30-minute deletion check ask Discord about each thread only once.
ALTER TABLE issue_mappings ADD COLUMN discord_inactive INTEGER NOT NULL DEFAULT 0;
