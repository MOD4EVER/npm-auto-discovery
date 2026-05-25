import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCliFlags } from '../../src/cli.js';

vi.mock('../../src/version.js', () => ({ VERSION: '1.2.3-test' }));

describe('checkCliFlags', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false and does nothing when no flags are passed', () => {
    expect(checkCliFlags([])).toBe(false);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns false for unrelated args', () => {
    expect(checkCliFlags(['--npm-url', 'http://npm:81'])).toBe(false);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  describe('--version / -v', () => {
    it.each([['--version'], ['-v']])('prints version and returns true for %s', (flag) => {
      expect(checkCliFlags([flag])).toBe(true);
      expect(stdoutSpy).toHaveBeenCalledOnce();
      expect(stdoutSpy).toHaveBeenCalledWith('1.2.3-test');
    });

    it('handles --version anywhere in argv', () => {
      expect(checkCliFlags(['--foo', '--version', '--bar'])).toBe(true);
      expect(stdoutSpy).toHaveBeenCalledWith('1.2.3-test');
    });
  });

  describe('--help / -h', () => {
    it.each([['--help'], ['-h']])('prints help and returns true for %s', (flag) => {
      expect(checkCliFlags([flag])).toBe(true);
      expect(stdoutSpy).toHaveBeenCalledOnce();
      const output: string = stdoutSpy.mock.calls[0]?.[0] ?? '';
      expect(output).toContain('Usage: npm-auto-discovery');
      expect(output).toContain('NPM_URL');
      expect(output).toContain('NPM_EMAIL');
      expect(output).toContain('NPM_PASSWORD');
      expect(output).toContain('--version');
      expect(output).toContain('--help');
    });

    it('help output lists optional env vars', () => {
      checkCliFlags(['--help']);
      const output: string = stdoutSpy.mock.calls[0]?.[0] ?? '';
      expect(output).toContain('RECONCILE_INTERVAL_MS');
      expect(output).toContain('FORWARD_HOST_MODE');
      expect(output).toContain('PROXY_NETWORK_NAME');
      expect(output).toContain('NPM_MAX_RETRIES');
      expect(output).toContain('HEALTH_PORT');
      expect(output).toContain('LOG_LEVEL');
    });
  });

  it('--version takes precedence over --help when both are present', () => {
    expect(checkCliFlags(['--version', '--help'])).toBe(true);
    expect(stdoutSpy).toHaveBeenCalledWith('1.2.3-test');
  });
});
