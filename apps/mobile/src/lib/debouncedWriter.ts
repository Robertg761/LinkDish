/**
 * Coalesces rapid writes of a whole value (a cookbook or shopping list blob) into one write.
 *
 * `schedule` keeps only the latest value and writes it after `delayMs` of quiet; `flush` writes
 * a pending value now (call it when the app goes to the background so nothing is lost if the OS
 * kills the process). Writes never overlap and always land in schedule order.
 */
export interface DebouncedWriter<T> {
  cancel: () => void;
  flush: () => Promise<void>;
  hasPending: () => boolean;
  schedule: (value: T) => void;
}

export const createDebouncedWriter = <T>(
  write: (value: T) => Promise<void>,
  delayMs: number
): DebouncedWriter<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  let chain: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (): Promise<void> => {
    clearTimer();

    if (!pending) {
      return chain;
    }

    const { value } = pending;
    pending = null;
    chain = chain.then(
      () => write(value),
      () => write(value)
    );

    return chain;
  };

  return {
    cancel: () => {
      clearTimer();
      pending = null;
    },
    flush,
    hasPending: () => pending != null,
    schedule: (value) => {
      pending = { value };
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void flush().catch(() => undefined);
      }, delayMs);
    }
  };
};
