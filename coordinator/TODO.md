# End-to-End Observability for Order Lifecycle Transitions

## Steps

- [x] 1. Analyze codebase (state machine, order service, metrics, tests, Grafana)
- [x] 2. Plan approved by user

### Implementation

- [x] 3. Add new Prometheus metrics to `metrics.ts`
  - `orderLifecycleTransitions` Counter (direction, from, to)
  - `orderStateDuration` Histogram (direction, state)
  - `orderInvalidTransitions` Counter (from, to)
  - `orderCurrentState` Gauge (direction, state)

- [x] 4. Add invalid transition tracking in `order-machine.ts`

- [x] 5. Instrument `order-service.ts` at all transition points
  - announce(), recordSrcLock(), recordDstLock(), recordSecret(), markStatus()

- [x] 6. Fix `order-service.test.ts` to use valid state transitions

- [x] 7. Update Grafana dashboard with lifecycle panels

- [ ] 8. Verify tests pass

