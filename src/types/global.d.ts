export {};

declare global {
  interface Scheduler {
    yield(): Promise<void>;
  }

  var scheduler: Scheduler | undefined;
}
