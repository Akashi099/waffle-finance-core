import { describe, expect, it } from "vitest";

import { PressureController, PressureMode } from "../src/services/pressure-controller.js";

describe("pressure controller", () => {
  it("moves into restrained mode when lag and failure rate climb", () => {
    const controller = new PressureController({
      maxInFlightListeners: 4,
      maxInFlightReconciliations: 2,
      maxInFlightRecoveries: 2,
    });

    controller.observe({ kind: "listener", queueDepth: 40, lag: 100, failureRate: 0.6 });
    controller.observe({ kind: "reconciliation", queueDepth: 40, lag: 100, failureRate: 0.6 });
    controller.observe({ kind: "recovery", queueDepth: 40, lag: 100, failureRate: 0.6 });

    expect(controller.getMode()).toBe(PressureMode.RESTRAINED);
  });

  it("keeps the system permissive when load is light", () => {
    const controller = new PressureController();
    controller.observe({ kind: "listener", queueDepth: 2, lag: 3, failureRate: 0.05 });
    expect(controller.getMode()).toBe(PressureMode.NORMAL);
  });
});
