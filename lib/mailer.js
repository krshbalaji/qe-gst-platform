// No real email provider is wired up (this sandbox has no path to an SMTP server or a
// provider API). This logs the message clearly instead of silently failing, so password
// reset etc. are fully testable end-to-end -- the link just has to be copied from the
// server log instead of an inbox.
//
// To go live: install nodemailer (`npm install nodemailer`, pure JS, no native deps) and
// replace the body of sendMail() with a real transport, e.g.:
//
//   const nodemailer = require('nodemailer');
//   const transporter = nodemailer.createTransport({
//     host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
//     auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
//   });
//   async function sendMail({ to, subject, text }) {
//     await transporter.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
//   }
//
// Nothing else in the app needs to change -- every caller just does
// `await sendMail({ to, subject, text })`.

async function sendMail({ to, subject, text }) {
  console.log('----- [qe3] DEV MAILER: no real email provider is configured -----');
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(text);
  console.log('-------------------------------------------------------------------');
  return { delivered: false, devLogged: true };
}

module.exports = { sendMail };
