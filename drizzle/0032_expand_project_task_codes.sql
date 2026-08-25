DROP TRIGGER IF EXISTS `projects_task_code_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `projects_task_code_update_guard`;--> statement-breakpoint
CREATE TRIGGER `projects_task_code_insert_guard`
BEFORE INSERT ON `projects`
WHEN length(NEW.task_code) NOT BETWEEN 1 AND 12
  OR NEW.task_code GLOB '*[^A-Z0-9-]*'
  OR substr(NEW.task_code, 1, 1) NOT GLOB '[A-Z0-9]'
  OR substr(NEW.task_code, -1, 1) NOT GLOB '[A-Z0-9]'
  OR NEW.task_sequence < 0
  OR (NEW.task_sequence > 0 AND NEW.code_locked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'Invalid Project task code or sequence');
END;--> statement-breakpoint
CREATE TRIGGER `projects_task_code_update_guard`
BEFORE UPDATE OF `task_code`, `task_sequence`, `code_locked_at` ON `projects`
WHEN length(NEW.task_code) NOT BETWEEN 1 AND 12
  OR NEW.task_code GLOB '*[^A-Z0-9-]*'
  OR substr(NEW.task_code, 1, 1) NOT GLOB '[A-Z0-9]'
  OR substr(NEW.task_code, -1, 1) NOT GLOB '[A-Z0-9]'
  OR NEW.task_sequence < OLD.task_sequence
  OR (NEW.task_sequence > 0 AND NEW.code_locked_at IS NULL)
  OR (OLD.code_locked_at IS NOT NULL AND NEW.code_locked_at IS NULL)
  OR (OLD.code_locked_at IS NOT NULL AND NEW.task_code <> OLD.task_code)
BEGIN
  SELECT RAISE(ABORT, 'Invalid or locked Project task code or sequence');
END;
