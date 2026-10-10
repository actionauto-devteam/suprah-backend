import fs from 'fs';
import path from 'path';
import CallRoutingConfig from '../../src/models/CallRoutingConfig.model';
import { CallRecordingPolicy } from '../../src/models/CallRecording.model';

const { minimatch } = require('minimatch');
const patterns = fs.readFileSync(path.join(__dirname, '../../.dockerignore'), 'utf8')
  .split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'));
const excluded = (file: string) => patterns.reduce((result, pattern) => {
  const exception = pattern.startsWith('!');
  return minimatch(file, exception ? pattern.slice(1) : pattern, { dot: true }) ? !exception : result;
}, false);

test.each(['.env', '.env.local', '.env.production', '.env.staging.local', 'nested/.env', 'nested/.env.local', 'nested/deeper/.env.secret'])('excludes %s from release contexts', file => {
  expect(excluded(file)).toBe(true);
});

test.each(['.env.example', 'nested/.env.example', 'src/server.ts', 'package.json'])('preserves intended template/source %s', file => {
  expect(excluded(file)).toBe(false);
});

test('IVR and Recording are opt-in with unapproved provider/legal defaults', () => {
  const routing: any = new CallRoutingConfig();
  const recording: any = new CallRecordingPolicy();
  expect(routing.enabled).toBe(false);
  expect(routing.allOrgFallback).toBe(false);
  expect(recording.enabled).toBe(false);
  expect(recording.providerVerified).toBe(false);
  expect(recording.legalApproved).toBe(false);
  expect(recording.providerDisclosureVerified).toBe(false);
  expect(recording.consentMode).toBe('pending');
});
