import { describe, it, expect } from 'vitest';
import { ANSI } from './ansi';
import { formatDate, formatRelativeTime, getStatusBadge } from './auth-menu';

describe('auth-menu helpers', () => {
  describe('formatRelativeTime', () => {
    it('returns "never" for undefined', () => {
      expect(formatRelativeTime(undefined)).toBe('never');
    });

    it('returns "today" for same day', () => {
      expect(formatRelativeTime(Date.now())).toBe('today');
      expect(formatRelativeTime(Date.now() - 1000)).toBe('today');
    });

    it('returns "yesterday" for 1 day ago', () => {
      const yesterday = Date.now() - 86400000;
      expect(formatRelativeTime(yesterday)).toBe('yesterday');
    });

    it('returns "Xd ago" for 2-6 days', () => {
      expect(formatRelativeTime(Date.now() - 2 * 86400000)).toBe('2d ago');
      expect(formatRelativeTime(Date.now() - 6 * 86400000)).toBe('6d ago');
    });

    it('returns "Xw ago" for 7-29 days', () => {
      expect(formatRelativeTime(Date.now() - 7 * 86400000)).toBe('1w ago');
      expect(formatRelativeTime(Date.now() - 14 * 86400000)).toBe('2w ago');
      expect(formatRelativeTime(Date.now() - 28 * 86400000)).toBe('4w ago');
    });

    it('returns formatted date for 30+ days', () => {
      const oldDate = Date.now() - 60 * 86400000;
      const result = formatRelativeTime(oldDate);
      expect(result).not.toBe('never');
      expect(result).not.toContain('ago');
    });
  });

  describe('formatDate', () => {
    it('returns "unknown" for undefined', () => {
      expect(formatDate(undefined)).toBe('unknown');
    });

    it('returns formatted date for valid timestamp', () => {
      const result = formatDate(Date.now());
      expect(result).not.toBe('unknown');
      expect(typeof result).toBe('string');
    });
  });

  describe('getStatusBadge', () => {
    it('returns green badge for active status', () => {
      const badge = getStatusBadge('active');
      expect(badge).toContain('[active]');
      expect(badge).toContain(ANSI.green);
    });

    it('returns yellow badge for rate-limited status', () => {
      const badge = getStatusBadge('rate-limited');
      expect(badge).toContain('[rate-limited]');
      expect(badge).toContain(ANSI.yellow);
    });

    it('returns red badge for expired (revoked) status', () => {
      const badge = getStatusBadge('expired');
      expect(badge).toContain('[signed out - refresh token]');
      expect(badge).toContain(ANSI.red);
    });

    it('returns red badge for accounts needing verification', () => {
      const badge = getStatusBadge('verification-required');
      expect(badge).toContain('[needs verification]');
      expect(badge).toContain(ANSI.red);
    });

    it('returns empty string for unknown status', () => {
      expect(getStatusBadge('unknown')).toBe('');
      expect(getStatusBadge(undefined)).toBe('');
    });
  });
});
