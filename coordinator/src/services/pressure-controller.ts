export enum PressureMode {
  NORMAL = "normal",
  RESTRAINED = "restrained",
}

export interface PressureSnapshot {
  kind: "listener" | "reconciliation" | "recovery";
  queueDepth: number;
  lag: number;
  failureRate: number;
}

export interface PressureControllerOptions {
  maxInFlightListeners?: number;
  maxInFlightReconciliations?: number;
  maxInFlightRecoveries?: number;
}

export class PressureController {
  private mode = PressureMode.NORMAL;
  private readonly maxInFlightListeners: number;
  private readonly maxInFlightReconciliations: number;
  private readonly maxInFlightRecoveries: number;

  constructor(options: PressureControllerOptions = {}) {
    this.maxInFlightListeners = options.maxInFlightListeners ?? 8;
    this.maxInFlightReconciliations = options.maxInFlightReconciliations ?? 4;
    this.maxInFlightRecoveries = options.maxInFlightRecoveries ?? 3;
  }

  observe(snapshot: PressureSnapshot): void {
    const overload =
      snapshot.queueDepth > 32 ||
      snapshot.lag > 50 ||
      snapshot.failureRate > 0.3;

    if (overload) {
      this.mode = PressureMode.RESTRAINED;
      return;
    }

    this.mode = PressureMode.NORMAL;
  }

  getMode(): PressureMode {
    return this.mode;
  }

  getLimits(): { listeners: number; reconciliations: number; recoveries: number } {
    return {
      listeners: this.mode === PressureMode.RESTRAINED ? Math.max(1, Math.floor(this.maxInFlightListeners / 2)) : this.maxInFlightListeners,
      reconciliations: this.mode === PressureMode.RESTRAINED ? Math.max(1, Math.floor(this.maxInFlightReconciliations / 2)) : this.maxInFlightReconciliations,
      recoveries: this.mode === PressureMode.RESTRAINED ? Math.max(1, Math.floor(this.maxInFlightRecoveries / 2)) : this.maxInFlightRecoveries,
    };
  }
}
