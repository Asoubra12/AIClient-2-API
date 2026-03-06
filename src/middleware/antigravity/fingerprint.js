import { v4 as uuidv4 } from 'uuid';
import { getFingerprint, saveFingerprint } from '../../db/fingerprint-store.js';

const DEFAULT_IDE_VERSION = '1.19.6';

function sanitizeUserName(accountEmail) {
  const rawValue = typeof accountEmail === 'string' ? accountEmail.split('@')[0] : 'user';
  const sanitized = rawValue.replace(/[^A-Za-z0-9._-]/g, '');
  return sanitized || 'user';
}

function pickProfile(random) {
  const roll = random();
  if (roll < 0.8) {
    return { os: 'windows', hardware: 'amd64' };
  }
  if (roll < 0.95) {
    return { os: 'darwin', hardware: 'arm64' };
  }
  return { os: 'linux', hardware: 'amd64' };
}

function buildExtensionPath(osName, userName) {
  if (osName === 'windows') {
    return `c:\\Users\\${userName}\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity`;
  }

  if (osName === 'darwin') {
    return `/Users/${userName}/.vscode/extensions/antigravity`;
  }

  return `/home/${userName}/.vscode/extensions/antigravity`;
}

export function toPlatformId(fingerprint) {
  const osName = fingerprint?.os || 'windows';
  const hardware = fingerprint?.hardware || 'amd64';
  return `${osName}_${hardware}`.toUpperCase();
}

export class FingerprintManager {
  constructor({ createUuid = uuidv4, random = Math.random, ideVersion = DEFAULT_IDE_VERSION } = {}) {
    this.createUuid = createUuid;
    this.random = random;
    this.ideVersion = ideVersion;
  }

  getOrCreateFingerprint(accountEmail) {
    const existingFingerprint = getFingerprint(accountEmail);
    if (existingFingerprint) {
      return existingFingerprint;
    }

    const userName = sanitizeUserName(accountEmail);
    const profile = pickProfile(this.random);
    const fingerprint = {
      deviceFingerprint: this.createUuid(),
      extensionName: 'antigravity',
      extensionPath: buildExtensionPath(profile.os, userName),
      hardware: profile.hardware,
      ideName: 'antigravity',
      ideVersion: this.ideVersion,
      locale: 'en',
      os: profile.os,
      regionCode: 'US',
      userTierId: 'free-tier',
    };

    saveFingerprint(accountEmail, fingerprint);
    return fingerprint;
  }
}

export const fingerprintManager = new FingerprintManager();
