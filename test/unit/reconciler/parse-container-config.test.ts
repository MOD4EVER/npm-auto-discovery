import { describe, expect, it } from 'vitest';
import { parseContainerConfig } from '../../../src/reconciler/parse-container-config.js';

describe('parseContainerConfig()', () => {
  describe('VIRTUAL_HOST handling', () => {
    it('returns null when env is null', () => {
      expect(parseContainerConfig(null)).toBeNull();
    });

    it('returns null when env is empty array', () => {
      expect(parseContainerConfig([])).toBeNull();
    });

    it('returns null when VIRTUAL_HOST is not present', () => {
      expect(parseContainerConfig(['SOME_VAR=value'])).toBeNull();
    });

    it('returns null when VIRTUAL_HOST is empty string', () => {
      expect(parseContainerConfig(['VIRTUAL_HOST='])).toBeNull();
    });

    it('returns null when VIRTUAL_HOST is whitespace only', () => {
      expect(parseContainerConfig(['VIRTUAL_HOST=   '])).toBeNull();
    });

    it('returns null when VIRTUAL_HOST contains only commas', () => {
      expect(parseContainerConfig(['VIRTUAL_HOST=,,,'])).toBeNull();
    });

    it('returns ContainerConfig with single domain and defaults', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=app.example.com']);
      expect(result).toEqual({
        domains: ['app.example.com'],
        port: 80,
        sslCertId: undefined,
        forwardHostMode: 'auto',
      });
    });

    it('splits comma-separated VIRTUAL_HOST into domains array', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=a.example.com,b.example.com']);
      expect(result?.domains).toEqual(['a.example.com', 'b.example.com']);
    });

    it('trims whitespace around commas in VIRTUAL_HOST', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST= a.example.com , b.example.com ']);
      expect(result?.domains).toEqual(['a.example.com', 'b.example.com']);
    });
  });

  describe('VIRTUAL_PORT handling', () => {
    it('defaults to 80 when VIRTUAL_PORT is absent', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=app.example.com']);
      expect(result?.port).toBe(80);
    });

    it('parses VIRTUAL_PORT as integer', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=app.example.com', 'VIRTUAL_PORT=3000']);
      expect(result?.port).toBe(3000);
    });

    it('falls back to 80 when VIRTUAL_PORT is not a valid integer', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=app.example.com', 'VIRTUAL_PORT=abc']);
      expect(result?.port).toBe(80);
    });

    it('falls back to 80 when VIRTUAL_PORT is zero or negative', () => {
      expect(parseContainerConfig(['VIRTUAL_HOST=app.example.com', 'VIRTUAL_PORT=0'])?.port).toBe(
        80,
      );
      expect(parseContainerConfig(['VIRTUAL_HOST=app.example.com', 'VIRTUAL_PORT=-1'])?.port).toBe(
        80,
      );
    });
  });

  describe('VIRTUAL_SSL_CERT_ID handling', () => {
    it('is undefined when VIRTUAL_SSL_CERT_ID is absent', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=app.example.com']);
      expect(result?.sslCertId).toBeUndefined();
    });

    it('parses VIRTUAL_SSL_CERT_ID as number (not string)', () => {
      const result = parseContainerConfig([
        'VIRTUAL_HOST=app.example.com',
        'VIRTUAL_SSL_CERT_ID=42',
      ]);
      expect(result?.sslCertId).toBe(42);
      expect(typeof result?.sslCertId).toBe('number');
    });

    it('is undefined when VIRTUAL_SSL_CERT_ID is not a valid integer', () => {
      const result = parseContainerConfig([
        'VIRTUAL_HOST=app.example.com',
        'VIRTUAL_SSL_CERT_ID=bad',
      ]);
      expect(result?.sslCertId).toBeUndefined();
    });
  });

  describe('FORWARD_HOST_MODE handling', () => {
    it('defaults to "auto" when FORWARD_HOST_MODE is absent', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=app.example.com']);
      expect(result?.forwardHostMode).toBe('auto');
    });

    it('accepts "dns" as a valid FORWARD_HOST_MODE', () => {
      const result = parseContainerConfig([
        'VIRTUAL_HOST=app.example.com',
        'FORWARD_HOST_MODE=dns',
      ]);
      expect(result?.forwardHostMode).toBe('dns');
    });

    it('accepts "ip" as a valid FORWARD_HOST_MODE', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=app.example.com', 'FORWARD_HOST_MODE=ip']);
      expect(result?.forwardHostMode).toBe('ip');
    });

    it('falls back to "auto" for an invalid FORWARD_HOST_MODE value', () => {
      const result = parseContainerConfig([
        'VIRTUAL_HOST=app.example.com',
        'FORWARD_HOST_MODE=invalid',
      ]);
      expect(result?.forwardHostMode).toBe('auto');
    });
  });

  describe('env array edge cases', () => {
    it('handles values containing "=" characters (e.g. base64)', () => {
      const result = parseContainerConfig(['VIRTUAL_HOST=app.example.com', 'SOME_KEY=abc=def=ghi']);
      expect(result).not.toBeNull();
      expect(result?.domains).toEqual(['app.example.com']);
    });

    it('last duplicate key wins', () => {
      const result = parseContainerConfig([
        'VIRTUAL_HOST=first.example.com',
        'VIRTUAL_HOST=second.example.com',
      ]);
      expect(result?.domains).toEqual(['second.example.com']);
    });

    it('ignores malformed entries with no "=" separator', () => {
      const result = parseContainerConfig(['MALFORMED_ENTRY', 'VIRTUAL_HOST=app.example.com']);
      expect(result?.domains).toEqual(['app.example.com']);
    });
  });
});

describe('parseContainerConfig() — domain normalization', () => {
  it('strips a URL scheme from VIRTUAL_HOST', () => {
    const result = parseContainerConfig(['VIRTUAL_HOST=https://db.example.com']);
    expect(result?.domains).toEqual(['db.example.com']);
  });

  it('strips path, port and trailing dot, and lowercases', () => {
    const result = parseContainerConfig(['VIRTUAL_HOST=http://App.Example.com.:8443/admin?x=1']);
    expect(result?.domains).toEqual(['app.example.com']);
  });

  it('normalizes each comma-separated domain independently', () => {
    const result = parseContainerConfig(['VIRTUAL_HOST=https://a.example.com/, b.example.com']);
    expect(result?.domains).toEqual(['a.example.com', 'b.example.com']);
  });

  it('drops entries that are empty after normalization', () => {
    const result = parseContainerConfig(['VIRTUAL_HOST=https://,app.example.com']);
    expect(result?.domains).toEqual(['app.example.com']);
  });
});
