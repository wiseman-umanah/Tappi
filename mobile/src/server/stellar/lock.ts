// Transactions sourced from one account must not race for its sequence number. On a single dev
// server an in-process queue per account is enough.
const queues = new Map<string, Promise<unknown>>();

export function serialize<T>(account: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(account) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(account, next);
  return next;
}
