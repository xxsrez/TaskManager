import type { UserProfile } from "./types";

export type UserPreferenceChanges = {
  theme?: "system" | "light" | "dark";
  sidebarPreference?: "expanded" | "collapsed";
};

type PreferenceSaveQueueOptions = {
  current: () => UserProfile;
  save: (version: number, changes: UserPreferenceChanges) => Promise<UserProfile>;
  refresh: () => Promise<UserProfile>;
  isConflict: (error: unknown) => boolean;
  optimistic?: (changes: UserPreferenceChanges) => void;
  apply: (profile: UserProfile, pending?: UserPreferenceChanges | null) => void;
  error: (error: unknown) => void;
};

export function createUserPreferenceSaveQueue(options: PreferenceSaveQueueOptions) {
  let pending: UserPreferenceChanges | null = null;
  let running: Promise<void> | null = null;

  function start() {
    if (running) return running;
    running = drain().finally(() => {
      running = null;
      if (pending) void start();
    });
    return running;
  }

  async function drain() {
    while (pending) {
      let requested = pending;
      pending = null;
      let conflictRetried = false;

      for (;;) {
        try {
          const saved = await options.save(options.current().user.version, requested);
          options.apply(saved, pending);
          break;
        } catch (error) {
          let reportedError = error;
          if (options.isConflict(error) && !conflictRetried) {
            try {
              const latest = await options.refresh();
              requested = { ...requested, ...(pending ?? {}) };
              pending = null;
              options.apply(latest, requested);
              conflictRetried = true;
              continue;
            } catch (refreshError) {
              reportedError = refreshError;
            }
          }
          options.apply(options.current(), pending);
          options.error(reportedError);
          break;
        }
      }
    }
  }

  return {
    enqueue(changes: UserPreferenceChanges) {
      pending = { ...pending, ...changes };
      options.optimistic?.(changes);
      return start();
    },
    async idle() {
      while (running || pending) {
        if (!running) start();
        await running;
      }
    },
  };
}
