import { describe, it, expect } from 'bun:test';
import { needsSetupRedirect, googleAuthMessage } from './shell-init.js';

describe('needsSetupRedirect', () => {
  it('sends a first-run user to the wizard', () => {
    expect(needsSetupRedirect(null, null, '/home')).toBe(true);
  });
  it('respects either flag', () => {
    expect(needsSetupRedirect('1', null, '/home')).toBe(false);
    expect(needsSetupRedirect(null, '1', '/home')).toBe(false);
  });
  it('does not redirect from the setup flow itself', () => {
    expect(needsSetupRedirect(null, null, '/setup')).toBe(false);
    expect(needsSetupRedirect(null, null, '/welcome')).toBe(false);
  });
});

describe('googleAuthMessage', () => {
  it('is null without a google_auth result', () => {
    expect(googleAuthMessage(new URLSearchParams('a=1'))).toBeNull();
  });
  it('announces a success', () => {
    expect(googleAuthMessage(new URLSearchParams('google_auth=success'))?.text)
      .toBe('✓ Google connected successfully');
  });
  it('carries the error, or a default one', () => {
    expect(googleAuthMessage(new URLSearchParams('google_auth=error&error=denied'))?.text)
      .toBe('⚠ Google auth failed: denied');
    expect(googleAuthMessage(new URLSearchParams('google_auth=error'))?.text)
      .toBe('⚠ Google auth failed: Unknown error');
  });
});
