import { describe, expect, it } from 'vitest';
import { canCancel, isOrderStatus, isTerminal, nextStatus, ORDER_STATUSES } from '../../src/service/orders/state.js';

describe('order state machine', () => {
  it('walks Not Started → Started → Ready for Pickup → Delivered', () => {
    expect(nextStatus('NOT_STARTED')).toBe('STARTED');
    expect(nextStatus('STARTED')).toBe('READY_FOR_PICKUP');
    expect(nextStatus('READY_FOR_PICKUP')).toBe('DELIVERED');
  });

  it.each(['DELIVERED', 'CANCELLED'] as const)('%s is final: no next status and nobody can cancel', (s) => {
    expect(nextStatus(s)).toBeNull();
    expect(isTerminal(s)).toBe(true);
    for (const actor of ['customer', 'kitchen', 'system'] as const) expect(canCancel(s, actor)).toBe(false);
  });

  it('the customer can cancel only while Not Started', () => {
    expect(ORDER_STATUSES.filter((s) => canCancel(s, 'customer'))).toEqual(['NOT_STARTED']);
  });

  it('the kitchen can cancel at any status that is not final', () => {
    expect(ORDER_STATUSES.filter((s) => canCancel(s, 'kitchen'))).toEqual(['NOT_STARTED', 'STARTED', 'READY_FOR_PICKUP']);
  });

  it('every non-terminal status leads to a terminal one (no dead ends or loops)', () => {
    for (const start of ORDER_STATUSES) {
      let s = start;
      for (let i = 0; i < ORDER_STATUSES.length && !isTerminal(s); i++) s = nextStatus(s)!;
      expect(isTerminal(s)).toBe(true);
    }
  });

  it('recognises only known statuses', () => {
    expect(isOrderStatus('STARTED')).toBe(true);
    expect(isOrderStatus('started')).toBe(false);
    expect(isOrderStatus(undefined)).toBe(false);
  });
});
