import 'server-only';
import nodemailer from 'nodemailer';
import { AppError } from './errors';
export type Mail = {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: string }[];
};
function emailFailure(code: string, message: string): never {
  // Do not log SMTP responses: they can contain addresses, credentials or message content.
  console.error('Email delivery failed', { code });
  throw new AppError(503, message);
}
export function checkEmailConfiguration() {
  if (process.env.EMAIL_PROVIDER === 'console' && process.env.NODE_ENV !== 'production') return;
  if (
    process.env.EMAIL_PROVIDER !== 'smtp' ||
    !process.env.SMTP_HOST?.trim() ||
    !process.env.EMAIL_FROM?.trim()
  )
    emailFailure(
      'EMAIL_NOT_CONFIGURED',
      'Email delivery is not configured. Ask an administrator to finish email setup.',
    );
  const port = Number(process.env.SMTP_PORT ?? 587);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !!process.env.SMTP_USER !== !!process.env.SMTP_PASSWORD ||
    (process.env.SMTP_SECURE !== undefined && !['true', 'false'].includes(process.env.SMTP_SECURE))
  )
    emailFailure(
      'EMAIL_CONFIGURATION_INVALID',
      'Email settings are incomplete or invalid. Ask an administrator to check the SMTP port, security setting, username and password.',
    );
}
export async function sendEmail(mail: Mail) {
  checkEmailConfiguration();
  if (process.env.EMAIL_PROVIDER === 'console' && process.env.NODE_ENV !== 'production') {
    console.info('[development email]', JSON.stringify(mail));
    return;
  }
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
      connectionTimeout: 10000,
      socketTimeout: 15000,
    });
    await transport.sendMail({ from: process.env.EMAIL_FROM, ...mail });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'EAUTH')
      emailFailure(
        'EMAIL_AUTH_FAILED',
        'The email provider rejected the SMTP login. Ask an administrator to check the email credentials.',
      );
    if (
      ['ECONNECTION', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(
        String(code),
      )
    )
      emailFailure(
        'EMAIL_CONNECTION_FAILED',
        'The app could not connect to the email provider. Ask an administrator to check the SMTP host, port and connection settings.',
      );
    if (code === 'ETLS')
      emailFailure(
        'EMAIL_TLS_FAILED',
        'The secure connection to the email provider failed. Ask an administrator to check the SMTP security settings.',
      );
    if (code === 'EENVELOPE' || code === 'EMESSAGE')
      emailFailure(
        'EMAIL_REJECTED',
        'The email provider rejected this message. Ask an administrator to check the approved sender and recipient address.',
      );
    emailFailure(
      'EMAIL_SEND_FAILED',
      'The email could not be sent. Please try again later or ask an administrator to check email delivery.',
    );
  }
}
export function appUrl() {
  const url = new URL(process.env.APP_URL ?? 'http://localhost:3000');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new Error('APP_URL must use HTTPS in production.');
  return url.origin;
}
