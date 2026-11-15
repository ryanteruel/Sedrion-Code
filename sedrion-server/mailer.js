const nodemailer = require('nodemailer');

// Paste your Gmail address and 16-character Google App Password here:
const GMAIL_USER = process.env.SMTP_USER || 'teruellryan@gmail.com';
const GMAIL_APP_PASSWORD = process.env.SMTP_PASS || 'esoq qqmc pgup ofcg';

const isConfigured =
  GMAIL_USER &&
  GMAIL_APP_PASSWORD &&
  !GMAIL_USER.includes('your-email') &&
  !GMAIL_APP_PASSWORD.includes('xxxx');

const transporter = isConfigured
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
      },
    })
  : null;

async function sendMail({ to, subject, html, fallbackLog }) {
  if (!transporter) {
    console.log(`\n[EMAIL PREVIEW — Configure GMAIL_USER & GMAIL_APP_PASSWORD in mailer.js]`);
    console.log(`To: ${to} | Subject: ${subject}`);
    console.log(`${fallbackLog}\n`);
    return;
  }

  await transporter.sendMail({
    from: `"Sedrion Muntinlupa" <${GMAIL_USER}>`,
    to,
    subject,
    html,
  });
}

// 1. Successfully Joining (Welcome Email)
async function sendWelcomeEmail({ to, firstName, fullName, ntfyTopic }) {
  await sendMail({
    to,
    subject: 'Welcome to Sedrion — Volunteer Registration Complete',
    fallbackLog: `Welcome ${fullName}! Your ntfy topic: ${ntfyTopic}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:20px;border:1px solid #e2e8f0;border-radius:10px;">
        <h2 style="margin:0 0 10px;color:#0f172a;">Welcome to Sedrion, ${firstName}!</h2>
        <p style="color:#334155;line-height:1.5;">
          You have successfully joined the <strong>Sedrion Drainage Monitoring Volunteer Team</strong> in Muntinlupa.
          Your account is now active and ready for site assignments.
        </p>
        ${
          ntfyTopic
            ? `<div style="background:#f1f5f9;padding:12px 14px;border-radius:8px;margin:16px 0;">
                <p style="margin:0 0 6px;font-size:13px;color:#475569;"><strong>Your Personal Mobile Alert Topic (ntfy.sh):</strong></p>
                <code style="font-size:15px;font-weight:bold;color:#0f172a;">${ntfyTopic}</code>
                <p style="margin:8px 0 0;font-size:12px;color:#64748b;">
                  Install the free <strong>ntfy</strong> app on iOS or Android and subscribe to this topic to receive real-time flood &amp; dispatch alerts.
                </p>
              </div>`
            : ''
        }
        <p style="font-size:12px;color:#64748b;margin-top:18px;">— Sedrion Muntinlupa Dispatch</p>
      </div>
    `,
  });
}

// 2. Account Activation Email (6-Digit Code)
async function sendActivationEmail({ to, firstName, code }) {
  await sendMail({
    to,
    subject: `${code} is your Sedrion Account Activation Code`,
    fallbackLog: `Activation Code for ${to}: ${code}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:20px;border:1px solid #e2e8f0;border-radius:10px;">
        <h2 style="margin:0 0 10px;color:#0f172a;">Activate Your Sedrion Account</h2>
        <p style="color:#334155;">Hi ${firstName}, enter this 6-digit code on the Sedrion sign-in page to activate your volunteer account:</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:6px;text-align:center;background:#f1f5f9;padding:16px;border-radius:8px;margin:18px 0;color:#0f172a;">
          ${code}
        </div>
        <p style="font-size:12px;color:#64748b;">If you did not register for Sedrion, you can ignore this email.</p>
      </div>
    `,
  });
}

// 3. Forgot Password Email (6-Digit Sign-In Code)
async function sendForgotPasswordEmail({ to, firstName, code }) {
  await sendMail({
    to,
    subject: `${code} is your Sedrion Sign-In Code`,
    fallbackLog: `Forgot Password Code for ${to}: ${code}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:20px;border:1px solid #e2e8f0;border-radius:10px;">
        <h2 style="margin:0 0 10px;color:#0f172a;">Sedrion Account Recovery</h2>
        <p style="color:#334155;">Hi ${firstName || 'Volunteer'}, enter this 6-digit code in the Sedrion recovery window to sign back into your account:</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:6px;text-align:center;background:#f1f5f9;padding:16px;border-radius:8px;margin:18px 0;color:#0f172a;">
          ${code}
        </div>
        <p style="font-size:12px;color:#64748b;">This code expires in 10 minutes. Never share it with anyone.</p>
      </div>
    `,
  });
}

module.exports = {
  sendWelcomeEmail,
  sendActivationEmail,
  sendForgotPasswordEmail,
};