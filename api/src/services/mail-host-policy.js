require('../imap-patch');
const imaps = require('imap-simple');
const net = require('net');
const { decrypt } = require('../security/encryption');
const { normalizeNetworkHost, isTrustedMailHost, isPublicNetworkAddress, resolveNetworkHost, resolveMailConnectionTarget } = require('../security/outbound-network');

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

function normalizeHost(host) {
  return normalizeNetworkHost(host);
}

function isKnownMailProviderHost(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return false;
  return KNOWN_MAIL_HOST_SUFFIXES.some(suffix => normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`));
}

function toBooleanFlag(value) {
  return value === true || value === 1 || value === '1';
}

function isSelfSignedTlsError(message) {
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

function isTlsTrustError(errorOrMessage) {
  const values = typeof errorOrMessage === 'object' && errorOrMessage !== null
    ? [
        errorOrMessage.message,
        errorOrMessage.code,
        errorOrMessage.source,
        errorOrMessage.authorizationError,
        errorOrMessage.reason,
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

async function assessMailHost(host, port) {
  const normalizedHost = normalizeHost(host);
  const knownProvider = isKnownMailProviderHost(normalizedHost);
  const allowlisted = isTrustedMailHost(normalizedHost);
  const reasons = [];

  if (!knownProvider && !allowlisted) {
    reasons.push('unknown_provider');
  }

  let resolvedAddresses = [];
  let resolveError = null;
  try {
    resolvedAddresses = (await resolveNetworkHost(normalizedHost)).map(entry => entry.address);
  } catch (error) {
    resolveError = error.message;
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

async function buildMailHostTrustResult({ imap_host, imap_port, smtp_host, smtp_port, imapTlsError = null }) {
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

  const requiresInsecureTls = Boolean(imapTlsError);
  return {
    blocked,
    requiresConfirmation: requiresInsecureTls,
    requiresInsecureTls,
    warnings,
    assessments,
    certificates: requiresInsecureTls
      ? {
          imap: {
            authorized: false,
            authorizationError: imapTlsError,
            error: imapTlsError,
          },
        }
      : {},
  };
}

async function validateMailHostPolicy({ imap_host, imap_port, smtp_host, smtp_port }) {
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

async function buildImapConnectionConfig(account, { keepalive = true } = {}) {
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
      tlsOptions: {
        rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
      },
      connTimeout: 60000,
      authTimeout: 30000,
      socketTimeout: 60000,
      keepalive,
    },
  };
}

// ── Mail sync and send functions ──────────────────────────────────

// Test IMAP connection and authentication without syncing.
async function testImapConnection(account) {
  let connection = null;
  const imapPort = account.imap_port || 993;
  try {
    const config = await buildImapConnectionConfig(account, { keepalive: false });
    if (!config) return { success: false, error: 'No password configured' };

    connection = await imaps.connect(config);
    connection.on('error', (err) => {
      console.error('[ACCOUNT] IMAP connection error (handled):', err.message);
    });
    await connection.openBox('INBOX');
    
    // Connection successful
    if (connection) connection.end();
    return { success: true };
  } catch (error) {
    if (connection) {
      try { connection.end(); } catch (e) { /* ignore */ }
    }
    const errorMsg = error.message || String(error);
    const tlsTrustError = isTlsTrustError(error);
    console.error('[ACCOUNT] IMAP test failed:', {
      host: account.imap_host,
      port: imapPort,
      rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
      code: error.code || null,
      source: error.source || null,
      message: errorMsg,
      tlsTrustError,
    });

    let friendlyError = errorMsg;
    if (tlsTrustError && !toBooleanFlag(account.allow_self_signed)) {
      friendlyError = 'IMAP certificate could not be verified. Review and confirm mail server authenticity before continuing.';
    } else if (errorMsg.includes('AUTHENTICATIONFAILED') || errorMsg.includes('Invalid credentials')) {
      friendlyError = 'Authentication failed. Check your username and password (use App Password for Gmail/Yahoo).';
    } else if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
      friendlyError = 'Connection timeout. Check server address and port.';
    } else if (errorMsg.includes('ENOTFOUND')) {
      friendlyError = 'Server not found. Check the IMAP host address.';
    } else if (errorMsg.includes('ECONNREFUSED')) {
      friendlyError = 'Connection refused. Check the IMAP port and server settings.';
    } else if (errorMsg.includes('Connection ended unexpectedly') || errorMsg.includes('ECONNRESET')) {
      friendlyError = 'Connection closed by server. Check your credentials and server settings.';
    }

    return {
      success: false,
      error: friendlyError,
      details: errorMsg,
      code: error.code || null,
      tlsTrustError,
    };
  }
}

module.exports = {
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
  testImapConnection,
};
