/**
 * Coalesces rapid writes of a whole value (a cookbook or shopping list blob) into one write.
 *
 * `schedule` keeps only the latest value and writes it after `delayMs` of quiet; `flush` writes
 * a pending value now (call it when the app goes to the background so nothing is lost if the OS
 * kills the process); `writeNow` replaces anything pending with an explicit value and reports
 * whether that write succeeded. Writes never overlap and always land in call order, so an older
 * debounced snapshot can never overwrite a newer explicit save.
 */
export interface DebouncedWriter<T> {
  cancel: () => void;
  flush: () => Promise<void>;
  hasPending: () => boolean;
  schedule: (value: T) => void;
  writeNow: (value: T) => Promise<void>;
}

export const createDebouncedWriter = <T>(
  write: (value: T) => Promise<void>,
  delayMs: number,
  onBackgroundError: (error: unknown) => void = () => undefined
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

  const enqueue = (value: T): Promise<void> => {
    const next = chain.then(
      () => write(value),
      () => write(value)
    );
    chain = next.catch(() => undefined);
    return next;
  };

  const flush = (): Promise<void> => {
    clearTimer();

    if (!pending) {
      return chain;
    }

    const { value } = pending;
    pending = null;
    return enqueue(value);
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
        void flush().catch(onBackgroundError);
      }, delayMs);
    },
    writeNow: (value) => {
      clearTimer();
      pending = null;
      return enqueue(value);
    }
  };
};
