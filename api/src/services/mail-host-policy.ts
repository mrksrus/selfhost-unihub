import type { MailAccountIdentity, StoredFlag } from '../types';

import * as imapClient from './mail-imap-client';
import { db } from '../state';
import { log } from '../log';
import { decrypt } from '../security/encryption';
import { inspectMailCertificates, mailTlsOptions } from '../security/mail-certificates';
import {
  normalizeNetworkHost,
  isTrustedMailHost,
  isPublicNetworkAddress,
  resolveNetworkHost,
  resolveMailConnectionTarget,
} from '../security/outbound-network';

interface MailHostSettings { imap_host?: unknown; imap_port?: unknown; smtp_host?: unknown; smtp_port?: unknown }
interface TransportAccount extends MailAccountIdentity {
  id?: string;
  email_address: string;
  encrypted_password?: string | null;
  allow_self_signed?: StoredFlag;
  trusted_imap_fingerprint256?: string | null;
  trusted_smtp_fingerprint256?: string | null;
}
type RecordFingerprint = (fingerprint256: string) => void;
interface MailConnectionError {
  message?: string;
  code?: string;
  source?: unknown;
  authorizationError?: unknown;
  reason?: unknown;
  responseText?: string;
  authenticationFailed?: boolean;
}

const KNOWN_MAIL_HOST_SUFFIXES = [
  'gmail.com',
  'googlemail.com',
  'mail.me.com',
  'icloud.com',
  'yahoo.com',
  'outlook.com',
  'office365.com',
  'hotmail.com',
  'live.com',
];

function normalizeHost(host: unknown) {
  return normalizeNetworkHost(host);
}

function isKnownMailProviderHost(host: unknown) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return false;
  return KNOWN_MAIL_HOST_SUFFIXES.some(suffix => normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`));
}

function toBooleanFlag(value: unknown) {
  return value === true || value === 1 || value === '1';
}

function isSelfSignedTlsError(message: unknown) {
  const normalized = String(message || '').toUpperCase();
  if (!normalized) return false;
  return (
    normalized.includes('SELF SIGNED') ||
    normalized.includes('SELF-SIGNED') ||
    normalized.includes('SELF_SIGNED') ||
    normalized.includes('DEPTH_ZERO_SELF_SIGNED_CERT') ||
    normalized.includes('SELF_SIGNED_CERT_IN_CHAIN')
  );
}

function isTlsTrustError(errorOrMessage: unknown) {
  const values = typeof errorOrMessage === 'object' && errorOrMessage !== null
    ? [
        (errorOrMessage as MailConnectionError).message,
        (errorOrMessage as MailConnectionError).code,
        (errorOrMessage as MailConnectionError).source,
        (errorOrMessage as MailConnectionError).authorizationError,
        (errorOrMessage as MailConnectionError).reason,
      ]
    : [errorOrMessage];
  const normalized = values
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).toUpperCase())
    .join(' ');
  if (!normalized) return false;
  return (
    isSelfSignedTlsError(normalized) ||
    normalized.includes('CERT') ||
    normalized.includes('UNABLE_TO_VERIFY') ||
    normalized.includes('UNABLE_TO_GET_ISSUER') ||
    normalized.includes('UNABLE_TO_GET_CRL') ||
    normalized.includes('HOSTNAME') ||
    normalized.includes('ALTNAME') ||
    normalized.includes('EXPIRED') ||
    normalized.includes('NOT_YET_VALID')
  );
}

async function assessMailHost(host: unknown, port: unknown) {
  const normalizedHost = normalizeHost(host);
  const knownProvider = isKnownMailProviderHost(normalizedHost);
  const allowlisted = isTrustedMailHost(normalizedHost);
  const reasons = [];

  if (!knownProvider && !allowlisted) {
    reasons.push('unknown_provider');
  }

  let resolvedAddresses: string[] = [];
  let resolveError = null;
  try {
    resolvedAddresses = (await resolveNetworkHost(normalizedHost)).map(entry => entry.address);
  } catch (error) {
    resolveError = (error as MailConnectionError).message;
  }

  if (resolveError) reasons.push('dns_resolution_failed');
  const privateAddresses = resolvedAddresses.filter(address => !isPublicNetworkAddress(address));
  if (privateAddresses.length > 0 && !allowlisted) {
    reasons.push('private_or_local_address');
  }

  return {
    host: normalizedHost,
    port: Number(port) || null,
    knownProvider,
    allowlisted,
    unknownProvider: !knownProvider && !allowlisted,
    blocked: !!resolveError || (privateAddresses.length > 0 && !allowlisted),
    reasons,
    resolvedAddresses,
    privateAddresses,
    resolveError,
  };
}

async function buildMailHostTrustResult({ imap_host, imap_port, smtp_host, smtp_port, imapTlsError = null, smtpTlsError = null }: MailHostSettings & { imapTlsError?: string | null; smtpTlsError?: string | null },
  { inspectCertificates = inspectMailCertificates }: { inspectCertificates?: typeof inspectMailCertificates } = {}) {
  const [imapAssessment, smtpAssessment] = await Promise.all([
    assessMailHost(imap_host, imap_port || 993),
    assessMailHost(smtp_host, smtp_port || 587),
  ]);
  const assessments = {
    imap: imapAssessment,
    smtp: smtpAssessment,
  };

  const blocked = imapAssessment.blocked || smtpAssessment.blocked;
  const warnings = [];
  if (imapAssessment.unknownProvider) warnings.push(`IMAP host "${imapAssessment.host}" is not a known provider.`);
  if (smtpAssessment.unknownProvider) warnings.push(`SMTP host "${smtpAssessment.host}" is not a known provider.`);
  if (imapAssessment.blocked) warnings.push(`IMAP host "${imapAssessment.host}" could not be safely resolved to an allowed address.`);
  if (smtpAssessment.blocked) warnings.push(`SMTP host "${smtpAssessment.host}" could not be safely resolved to an allowed address.`);
  if (imapTlsError) {
    warnings.push(`IMAP certificate for "${imapAssessment.host}" could not be verified by the mail login (${imapTlsError}).`);
  }
  if (smtpTlsError) warnings.push(`SMTP certificate for "${smtpAssessment.host}" could not be verified (${smtpTlsError}).`);

  if (blocked) {
    return {
      blocked,
      requiresConfirmation: true,
      requiresInsecureTls: false,
      warnings,
      assessments,
      certificates: {
        imap: { error: 'Blocked before certificate check because the host could not be safely resolved to an allowed address.' },
        smtp: { error: 'Blocked before certificate check because the host could not be safely resolved to an allowed address.' },
      },
    };
  }

  // Both certificates are shown, and confirming trusts exactly these two.
  const requiresInsecureTls = Boolean(imapTlsError || smtpTlsError);
  return {
    blocked,
    requiresConfirmation: requiresInsecureTls,
    requiresInsecureTls,
    warnings,
    assessments,
    certificates: requiresInsecureTls ? await inspectCertificates({ imap_host, imap_port, smtp_host, smtp_port }) : {},
  };
}

async function validateMailHostPolicy({ imap_host, imap_port, smtp_host, smtp_port }: MailHostSettings) {
  const mailHostTrust = await buildMailHostTrustResult({
    imap_host,
    imap_port,
    smtp_host,
    smtp_port,
  });

  if (mailHostTrust.blocked) {
    return {
      error: 'Mail host blocked because it could not be safely resolved to an allowed address. Ask the host administrator to add it to TRUSTED_MAIL_HOSTS if this is intentional.',
      status: 400,
      mailHostTrust,
    };
  }

  return {
    accepted: true,
    mailHostTrust,
  };
}

/**
 * Keeps the first certificate a confirmed account presents when no fingerprint
 * is stored yet: accounts confirmed before fingerprints were kept, or an SMTP
 * server whose certificate could not be read at confirmation.
 */
function recordConfirmedFingerprint(protocol: 'imap' | 'smtp', account: TransportAccount): RecordFingerprint | undefined {
  const id = account.id;
  if (!id) return undefined;
  const column = protocol === 'imap' ? 'trusted_imap_fingerprint256' : 'trusted_smtp_fingerprint256';
  return fingerprint256 => {
    account[column] = fingerprint256;
    db.execute(`UPDATE mail_accounts SET ${column} = ? WHERE id = ? AND allow_self_signed = TRUE AND ${column} IS NULL`, [fingerprint256, id])
      .then(() => log.info('mail', 'kept the certificate of a confirmed server', { account: id, protocol }))
      .catch((error: unknown) => log.warn('mail', 'could not keep a confirmed certificate', { account: id, protocol }, error));
  };
}

function accountTlsOptions(protocol: 'imap' | 'smtp', account: TransportAccount, hostname: string, record?: RecordFingerprint) {
  return mailTlsOptions(hostname, {
    confirmed: toBooleanFlag(account.allow_self_signed),
    fingerprint256: protocol === 'imap' ? account.trusted_imap_fingerprint256 : account.trusted_smtp_fingerprint256,
    record: record ?? recordConfirmedFingerprint(protocol, account),
  });
}

async function buildImapConnectionConfig(account: TransportAccount, { keepalive = true, record }: { keepalive?: boolean; record?: RecordFingerprint } = {}) {
  const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
  if (!password) return null;
  const imapPort = account.imap_port || 993;
  const target = await resolveMailConnectionTarget(account.imap_host);
  return {
    imap: {
      user: account.username || account.email_address,
      password,
      host: target.address,
      port: imapPort,
      tls: true,
      tlsOptions: accountTlsOptions('imap', account, target.hostname, record),
      connTimeout: 60000,
      authTimeout: 30000,
      socketTimeout: 60000,
      keepalive,
    },
  };
}

// ── Mail sync and send functions ──────────────────────────────────

// Test IMAP connection and authentication without syncing.
async function testImapConnection(account: TransportAccount, { record }: { record?: RecordFingerprint } = {}) {
  let connection: Awaited<ReturnType<typeof imapClient.connectImap>> | null = null;
  const imapPort = account.imap_port || 993;
  try {
    const config = await buildImapConnectionConfig(account, { keepalive: false, record });
    if (!config) return { success: false, error: 'No password configured' };

    connection = await imapClient.connectImap(config);
    await connection.mailboxOpen('INBOX', { readOnly: true });
    try { await connection.logout(); } catch { /* the check already succeeded */ }
    connection.close();
    return { success: true };
  } catch (error) {
    if (connection) {
      try { connection.close(); } catch (e) { /* ignore */ }
    }
    const errorMsg = [(error as MailConnectionError).message || String(error), (error as MailConnectionError).responseText].filter(Boolean).join(': ');
    const tlsTrustError = isTlsTrustError(error);
    console.error('[ACCOUNT] IMAP test failed:', {
      host: account.imap_host,
      port: imapPort,
      rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
      code: (error as MailConnectionError).code || null,
      source: (error as MailConnectionError).source || null,
      message: errorMsg,
      tlsTrustError,
    });

    let friendlyError = errorMsg;
    if (tlsTrustError && !toBooleanFlag(account.allow_self_signed)) {
      friendlyError = 'IMAP certificate could not be verified. Review and confirm mail server authenticity before continuing.';
    } else if ((error as MailConnectionError).authenticationFailed || errorMsg.includes('AUTHENTICATIONFAILED') || errorMsg.includes('Invalid credentials')) {
      friendlyError = 'Authentication failed. Check your username and password (use App Password for Gmail/Yahoo).';
    } else if (errorMsg.includes('ETIMEDOUT') || /timeout|timed out/i.test(errorMsg) || /TIMEOUT/.test(String((error as MailConnectionError).code || ''))) {
      friendlyError = 'Connection timeout. Check server address and port.';
    } else if (errorMsg.includes('ENOTFOUND')) {
      friendlyError = 'Server not found. Check the IMAP host address.';
    } else if (errorMsg.includes('ECONNREFUSED')) {
      friendlyError = 'Connection refused. Check the IMAP port and server settings.';
    } else if (errorMsg.includes('Unexpected close') || errorMsg.includes('ECONNRESET') || ['NoConnection', 'EConnectionClosed'].includes((error as MailConnectionError).code || '')) {
      friendlyError = 'Connection closed by server. Check your credentials and server settings.';
    }

    return {
      success: false,
      error: friendlyError,
      details: errorMsg,
      code: (error as MailConnectionError).code || null,
      tlsTrustError,
    };
  }
}

export {
  KNOWN_MAIL_HOST_SUFFIXES,
  normalizeHost,
  isKnownMailProviderHost,
  toBooleanFlag,
  isSelfSignedTlsError,
  isTlsTrustError,
  assessMailHost,
  buildMailHostTrustResult,
  validateMailHostPolicy,
  buildImapConnectionConfig,
  accountTlsOptions,
  testImapConnection,
};
